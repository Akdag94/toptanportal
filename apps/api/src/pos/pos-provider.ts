/**
 * ToptanPortal API - Sanal POS Saglayici Katmani
 *
 * Turkiye'deki banka sanal POS'larinin buyuk cogunlugu ayni kaliba oturur:
 * magaza anahtariyla hesaplanan bir OZET (hash) ve bankaya gonderilen bir
 * FORM. Bu dosya o kalibi tarifler; banka farklari alan adlarindadir, akista
 * degil.
 *
 * KART VERISI BU KATMANDAN GECMEZ. Form yalnizca tutar, siparis kimligi ve
 * ozet tasir; kartini kullanici bankanin sayfasina girer. Bir "kolaylik" olarak
 * kart alanlarini portalde toplayip bankaya iletmek, sunucuyu PCI-DSS kapsamina
 * sokar ve o kapsamdan geri cikmanin ucuz bir yolu yoktur.
 */

import { createHash } from 'node:crypto';

export interface PosCredentials {
  merchantId: string;
  terminalId: string;
  /** Magaza anahtari - ozet hesabinda kullanilir, HIC gonderilmez. */
  storeKey: string;
  gatewayUrl: string;
  /** Bankanin geri donecegi adres. */
  callbackUrl: string;
}

export interface PosFormRequest {
  merchantOrderId: string;
  amount: string;
  currencyCode: string;
  installment: number;
  /** Basari ve hata donusunde kullanicinin gorecegi portal sayfasi. */
  returnUrl: string;
}

export interface PosForm {
  actionUrl: string;
  fields: Record<string, string>;
}

/**
 * Bankanin geri gonderdigi alanlardan cikarilan sonuc.
 *
 * `amount` BILINCLI OLARAK YOKTUR: tutar veritabanindaki islemden okunur.
 * Geri donus istemcinin tarayicisindan gecer; oradaki tutara guvenmek, 1 TL
 * odeyip 10.000 TL'lik borc kapatmanin en kisa yoludur.
 */
export interface PosCallbackResult {
  merchantOrderId: string;
  approved: boolean;
  providerRef: string | null;
  providerCode: string | null;
  authCode: string | null;
  maskedPan: string | null;
  cardBrand: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface PosProvider {
  readonly name: string;
  buildForm(request: PosFormRequest): PosForm;
  /**
   * Ozeti dogrular. FALSE donerse yanit REDDEDILIR - bankadan geldigi
   * dogrulanamayan bir "onaylandi" mesaji, odeme yapilmadan borc kapatir.
   */
  verify(payload: Record<string, string>): boolean;
  parseCallback(payload: Record<string, string>): PosCallbackResult;
}

/**
 * NestPay (Asseco) ailesi. Is Bankasi, Akbank, Ziraat, Halkbank ve Finansbank
 * gibi bankalarin 3D Pay Hosting akisi bu ailedendir.
 *
 * Ozet kurali: alanlar ADLARINA gore siralanir, degerler `|` ile birlestirilir
 * ve sonuna magaza anahtari eklenir. Alan sirasini sabit bir listeye yazmak
 * yaygin bir hatadir: banka yeni bir alan eklediginde ozet tutmaz ve tum
 * odemeler sessizce reddedilmeye baslar.
 */
export class NestPayProvider implements PosProvider {
  readonly name = 'nestpay';

  constructor(private readonly credentials: PosCredentials) {}

  buildForm(request: PosFormRequest): PosForm {
    const fields: Record<string, string> = {
      clientid: this.credentials.merchantId,
      storetype: '3d_pay_hosting',
      trantype: 'Auth',
      amount: request.amount,
      currency: request.currencyCode,
      oid: request.merchantOrderId,
      okUrl: this.credentials.callbackUrl,
      failUrl: this.credentials.callbackUrl,
      lang: 'tr',
      rnd: Date.now().toString(),
      hashAlgorithm: 'ver3',
      /* Taksit alani BOS gonderilir, "1" degil: bazi bankalarda "1" tek
         cekim degil "1 taksit" olarak yorumlanir ve komisyon farki dogar. */
      taksit: request.installment > 1 ? String(request.installment) : '',
    };

    fields.hash = this.computeHash(fields);

    return { actionUrl: this.credentials.gatewayUrl, fields };
  }

  verify(payload: Record<string, string>): boolean {
    const received = payload.HASH ?? payload.hash ?? '';
    if (received.length === 0) return false;

    const expected = this.computeHash(payload);

    /* Sabit zamanli karsilastirma gerekmez: karsilastirilan deger istemciden
       gelir ama SIR degildir - dogru ozeti uretmek icin magaza anahtari
       gerekir ve o anahtar hicbir zaman disari cikmaz. Yine de uzunluk
       kontrolu once yapilir. */
    return received.length === expected.length && received === expected;
  }

  parseCallback(payload: Record<string, string>): PosCallbackResult {
    /* Iki kosul BIRLIKTE aranir: 3D dogrulamasi (mdStatus) ve tahsilat sonucu
       (Response). Yalnizca mdStatus'e bakmak, 3D'den gecip bankanin provizyon
       vermedigi bir islemi basarili saymaktir. */
    const mdStatus = payload.mdStatus ?? '';
    const response = (payload.Response ?? '').toLowerCase();

    const threeDOk = mdStatus === '1' || mdStatus === '2' || mdStatus === '3' || mdStatus === '4';
    const approved = threeDOk && response === 'approved';

    return {
      merchantOrderId: payload.oid ?? payload.ReturnOid ?? '',
      approved,
      providerRef: payload.TransId ?? payload.HostRefNum ?? null,
      providerCode: payload.ProcReturnCode ?? null,
      authCode: mdStatus.length > 0 ? mdStatus : null,
      maskedPan: payload.maskedCreditCard ?? payload.MaskedPan ?? null,
      cardBrand: payload.cardBrand ?? payload.EXTRA_CARDBRAND ?? null,
      errorCode: approved ? null : (payload.ProcReturnCode ?? payload.mdStatus ?? null),
      errorMessage: approved
        ? null
        : (payload.ErrMsg ?? payload.mdErrorMsg ?? 'Banka işlemi onaylamadı.'),
    };
  }

  /**
   * ver3 ozeti: `hash` ve `encoding` disindaki TUM alanlar ada gore siralanir,
   * degerler kacislanip `|` ile birlestirilir, sona magaza anahtari eklenir.
   */
  private computeHash(payload: Record<string, string>): string {
    const entries = Object.entries(payload)
      .filter(([key]) => {
        const lower = key.toLowerCase();
        return lower !== 'hash' && lower !== 'encoding';
      })
      .sort(([a], [b]) => a.localeCompare(b, 'en'));

    const plain = entries
      .map(([, value]) => escapeHashValue(value ?? ''))
      .concat(escapeHashValue(this.credentials.storeKey))
      .join('|');

    return createHash('sha512').update(plain, 'utf8').digest('base64');
  }
}

/**
 * Ozet degerlerindeki ayrac karakterleri kacislanir.
 *
 * Kacislama olmadan, icinde `|` gecen bir alan degeri ozeti kaydirabilir ve
 * iki farkli istek ayni ozeti uretebilir. Banka dokumanlarinda bu adim
 * kolayca atlanir; atlandiginda hata gormezsiniz, yalnizca bir gun birinin
 * istismar ettigini gorursunuz.
 */
function escapeHashValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}
