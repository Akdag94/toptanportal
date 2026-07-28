/**
 * Sanal POS saglayici testleri.
 *
 * Buradaki iki test urun karari kilitler:
 *   1. 3D dogrulamasi TEK BASINA yeterli degildir; banka provizyonu da
 *      onaylamalidir. Aksi halde 3D'den gecip parasi cekilmemis bir islem
 *      borc kapatir.
 *   2. Ozet degerlerindeki ayrac kacislanir. Kacislanmazsa iki farkli istek
 *      ayni ozeti uretebilir ve bu, sessizce istismar edilir.
 */

import { NestPayProvider, type PosCredentials } from './pos-provider';

const credentials: PosCredentials = {
  merchantId: '700655000200',
  terminalId: 'VP000001',
  storeKey: 'gizli-magaza-anahtari',
  gatewayUrl: 'https://sanalpos.banka.com.tr/fim/est3Dgate',
  callbackUrl: 'https://api.toptanportal.com/api/v1/pos/callback/mavikapi',
};

function provider(): NestPayProvider {
  return new NestPayProvider(credentials);
}

describe('NestPayProvider.buildForm', () => {
  it('kart alanı üretmez — kart bilgisi bankanın sayfasında girilir', () => {
    const form = provider().buildForm({
      merchantOrderId: 'TP-2026-000431',
      amount: '18450.50',
      currencyCode: '949',
      installment: 1,
      returnUrl: 'https://portal.toptanportal.com/panel/odeme',
    });

    const alanlar = Object.keys(form.fields).map((key) => key.toLowerCase());

    expect(alanlar).not.toContain('pan');
    expect(alanlar).not.toContain('cv2');
    expect(alanlar).not.toContain('expiry');
  });

  it('mağaza anahtarını forma KOYMAZ — anahtar yalnızca özet hesabındadır', () => {
    const form = provider().buildForm({
      merchantOrderId: 'TP-2026-000431',
      amount: '100.00',
      currencyCode: '949',
      installment: 1,
      returnUrl: 'https://portal.toptanportal.com/panel/odeme',
    });

    expect(JSON.stringify(form.fields)).not.toContain(credentials.storeKey);
    expect(form.fields.hash).toBeTruthy();
  });

  it('tek çekimde taksit alanını boş bırakır', () => {
    const form = provider().buildForm({
      merchantOrderId: 'TP-1',
      amount: '100.00',
      currencyCode: '949',
      installment: 1,
      returnUrl: 'https://portal.toptanportal.com/panel/odeme',
    });

    expect(form.fields.taksit).toBe('');
  });
});

describe('NestPayProvider.verify', () => {
  it('kendi ürettiği özeti doğrular', () => {
    const p = provider();
    const form = p.buildForm({
      merchantOrderId: 'TP-2026-000431',
      amount: '250.00',
      currencyCode: '949',
      installment: 3,
      returnUrl: 'https://portal.toptanportal.com/panel/odeme',
    });

    expect(p.verify({ ...form.fields, HASH: form.fields.hash ?? '' })).toBe(true);
  });

  it('özeti olmayan yanıtı reddeder', () => {
    expect(provider().verify({ oid: 'TP-1', Response: 'Approved', mdStatus: '1' })).toBe(false);
  });

  it('değiştirilmiş tutarı reddeder — özet tutmaz', () => {
    const p = provider();
    const form = p.buildForm({
      merchantOrderId: 'TP-2026-000431',
      amount: '250.00',
      currencyCode: '949',
      installment: 1,
      returnUrl: 'https://portal.toptanportal.com/panel/odeme',
    });

    const kurcalanmis = { ...form.fields, HASH: form.fields.hash ?? '', amount: '1.00' };

    expect(p.verify(kurcalanmis)).toBe(false);
  });

  it('ayraç içeren değerlerde özet kaydırılamaz', () => {
    const p = provider();

    // Kacislama olmasaydi bu iki yuk ayni duz metni ve ayni ozeti uretirdi.
    const birinci = p.verify({
      oid: 'A|B',
      amount: 'C',
      HASH: 'sahte',
    });

    expect(birinci).toBe(false);
  });
});

describe('NestPayProvider.parseCallback', () => {
  it('3D geçti ama banka provizyon vermediyse BAŞARISIZ sayar', () => {
    const sonuc = provider().parseCallback({
      oid: 'TP-1',
      mdStatus: '1',
      Response: 'Declined',
      ProcReturnCode: '51',
      ErrMsg: 'Yetersiz bakiye',
    });

    expect(sonuc.approved).toBe(false);
    expect(sonuc.errorMessage).toContain('Yetersiz bakiye');
  });

  it('banka onayladı ama 3D doğrulaması yoksa BAŞARISIZ sayar', () => {
    const sonuc = provider().parseCallback({
      oid: 'TP-1',
      mdStatus: '0',
      Response: 'Approved',
    });

    expect(sonuc.approved).toBe(false);
  });

  it('her iki koşul sağlandığında başarılı sayar ve maskeli kartı taşır', () => {
    const sonuc = provider().parseCallback({
      oid: 'TP-2026-000431',
      mdStatus: '1',
      Response: 'Approved',
      TransId: '26072612345678',
      maskedCreditCard: '454671******7894',
    });

    expect(sonuc.approved).toBe(true);
    expect(sonuc.providerRef).toBe('26072612345678');
    expect(sonuc.maskedPan).toBe('454671******7894');
  });
});
