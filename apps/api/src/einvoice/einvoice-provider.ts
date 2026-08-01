/**
 * ToptanPortal API - e-Belge Entegrator Baglantisi
 *
 * Portal ile GIB arasinda ozel entegrator durur. Portal, GIB'e DOGRUDAN
 * baglanmaz: mali muhur ve GIB kanali entegratorde kalir. Mali muhurun ozel
 * anahtarini bir web uygulamasinin surecine koymak, o surecin her acigini
 * imza yetkisine cevirirdi - imzalanmis bir fatura ise geri alinamaz.
 *
 * HATA SINIFLANDIRMASI bu dosyanin asil isidir ve bildirim tasima katmaniyla
 * AYNI mantiktadir:
 *
 *   * Ag / zaman asimi / 5xx / 429  -> GECICI. Belge kuyrukta kalir, tekrar
 *                                     denenir.
 *   * 4xx (bicim hatasi, mukellef
 *     bulunamadi, numara tekrari)   -> KALICI. Tekrar denemek ayni sonucu
 *                                     verir; belge FAILED isaretlenir ve
 *                                     insana duser.
 *
 * Ayrim yapilmazsa iki kotu sonuctan biri olur: kalici hata kuyrugu tikar ve
 * ARKASINDAKI gecerli faturalar gonderilmez, ya da gecici hata belgeyi
 * basarisiz sayar ve kesilmis bir fatura gonderilmemis olarak kalir.
 *
 * ZAMAN ASIMI CEVAPSIZ BIRAKIR. "Gonderdim mi?" sorusunun cevabi yoktur; bu
 * yuzden gonderim belgenin ETTN'si uzerinden IDEMPOTENTTIR ve entegrator ayni
 * ETTN'yi ikinci kez aldiginda yeni belge uretmez. Idempotentlik olmadan
 * tekrar denemek, ayni faturayi iki kez kesmektir.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EDocumentStatus, type EDocumentStatus as Status } from '@toptanportal/contracts';

import type { AppConfig } from '../config/configuration';

/** Tekrar denenmesi ANLAMLI hata. */
export class ProviderTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderTransientError';
  }
}

/** Tekrar denendiginde ayni sonucu verecek hata. */
export class ProviderPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderPermanentError';
  }
}

export interface ProviderSendInput {
  /** ETTN. Idempotentligin anahtaridir. */
  uuid: string;
  documentNumber: string;
  kind: string;
  /** Alicinin VKN/TCKN'si - entegrator mukellef kontrolunu bununla yapar. */
  customerTaxNumber: string;
  xml: string;
}

export interface ProviderSendResult {
  /** Entegrator tarafindaki kimlik. Itirazlarda saglayiciya bu verilir. */
  providerRef: string;
  status: Status;
}

export interface ProviderStatusResult {
  status: Status;
  /** Alicinin ret gerekcesi veya GIB hata metni. */
  note: string | null;
  respondedAt: Date | null;
}

/**
 * Entegrator durum kodlarinin portal durumlarina eslesmesi.
 *
 * BILINMEYEN KOD "BASARILI" SAYILMAZ. Taninmayan bir kodu iyimser yorumlamak,
 * reddedilmis bir faturayi tahsil edilebilir gostermenin en kolay yoludur;
 * bilinmeyen kod belgeyi OLDUGU YERDE birakir ve gunluge dusen bir satir
 * uretir.
 */
const STATUS_MAP: Record<string, Status> = {
  QUEUED: EDocumentStatus.SENT,
  SENT: EDocumentStatus.SENT,
  PROCESSING: EDocumentStatus.SENT,
  DELIVERED: EDocumentStatus.DELIVERED,
  SUCCEED: EDocumentStatus.DELIVERED,
  ACCEPTED: EDocumentStatus.ACCEPTED,
  APPROVED: EDocumentStatus.ACCEPTED,
  REJECTED: EDocumentStatus.REJECTED,
  DECLINED: EDocumentStatus.REJECTED,
  ERROR: EDocumentStatus.FAILED,
  FAILED: EDocumentStatus.FAILED,
  INVALID: EDocumentStatus.FAILED,
  CANCELLED: EDocumentStatus.CANCELLED,
  CANCELED: EDocumentStatus.CANCELLED,
};

export function mapProviderStatus(code: string): Status | null {
  return STATUS_MAP[code.trim().toUpperCase()] ?? null;
}

@Injectable()
export class EInvoiceProvider {
  private readonly logger = new Logger(EInvoiceProvider.name);
  private readonly config: AppConfig;

  /** false ise uretim hatti kapalidir; arsiv ve sunum tarafi calisir. */
  readonly configured: boolean;

  constructor(configService: ConfigService) {
    this.config = configService.getOrThrow<AppConfig>('app');
    this.configured = Boolean(
      this.config.EINVOICE_PROVIDER_URL &&
        this.config.EINVOICE_API_KEY &&
        this.config.EINVOICE_SENDER_TAX_NUMBER &&
        this.config.EINVOICE_SENDER_TITLE,
    );

    if (!this.configured) {
      this.logger.warn(
        'e-Belge entegratörü yapılandırılmadı (EINVOICE_PROVIDER_URL / EINVOICE_API_KEY / ' +
          'EINVOICE_SENDER_TAX_NUMBER / EINVOICE_SENDER_TITLE). Belge ÜRETİLMEZ; ' +
          'arşiv ve indirme çalışmaya devam eder.',
      );
    }
  }

  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    const yanit = await this.call('POST', '/documents', {
      /* Idempotentlik anahtari ETTN'dir: ag zaman asiminda tekrar denemek
         zorunludur ve entegrator ayni ETTN'de yeni belge uretmemelidir. */
      uuid: input.uuid,
      documentNumber: input.documentNumber,
      documentType: input.kind,
      receiverIdentifier: input.customerTaxNumber,
      /* XML base64 tasinir: JSON govdesinde ham XML, kacis kurallarinin iki
         kez uygulandigi ve bozulmanin sessiz oldugu bir yerdir. */
      content: Buffer.from(input.xml, 'utf8').toString('base64'),
    });

    const providerRef = okuMetin(yanit, ['id', 'documentId', 'ref']);

    if (providerRef === null) {
      /* Entegrator kimlik dondurmediyse belgenin akibetini SORAMAYIZ. Bunu
         basarili saymak, izlenemeyen bir fatura birakmaktir. */
      throw new ProviderPermanentError(
        'Entegratör belge kimliği döndürmedi; belgenin durumu sorgulanamaz.',
      );
    }

    const durumKodu = okuMetin(yanit, ['status', 'state']);
    const durum = durumKodu ? mapProviderStatus(durumKodu) : null;

    if (durumKodu && durum === null) {
      this.logger.warn(
        `Entegratörden tanınmayan durum kodu geldi: "${durumKodu}". Belge GÖNDERİLDİ sayıldı.`,
      );
    }

    return { providerRef, status: durum ?? EDocumentStatus.SENT };
  }

  /**
   * GIB durumunu sorar.
   *
   * Belgenin akibetini SORMAK, bildirim beklemekten guvenlidir: geri bildirim
   * kaybolabilir, sorgu ise cevapsiz kalmaz. "Faturam ulasti mi" sorusunun
   * cevabini portalin kendi kaydindan verebilmesi gerekir.
   */
  async queryStatus(uuid: string): Promise<ProviderStatusResult | null> {
    const yanit = await this.call('GET', `/documents/${encodeURIComponent(uuid)}`);

    const durumKodu = okuMetin(yanit, ['status', 'state']);
    if (durumKodu === null) return null;

    const durum = mapProviderStatus(durumKodu);

    if (durum === null) {
      /* Bilinmeyen kod IYIMSER yorumlanmaz: belge oldugu yerde kalir ve bir
         sonraki turda tekrar sorulur. */
      this.logger.warn(`Tanınmayan e-belge durumu: "${durumKodu}" (${uuid}). Durum değiştirilmedi.`);
      return null;
    }

    const zaman = okuMetin(yanit, ['respondedAt', 'responseDate', 'updatedAt']);
    const tarih = zaman ? new Date(zaman) : null;

    return {
      status: durum,
      note: okuMetin(yanit, ['note', 'responseNote', 'message', 'errorMessage']),
      respondedAt: tarih && !Number.isNaN(tarih.getTime()) ? tarih : null,
    };
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    if (!this.configured) {
      throw new ProviderPermanentError('e-Belge entegratörü yapılandırılmadı.');
    }

    let response: Response;

    try {
      response = await fetch(`${this.config.EINVOICE_PROVIDER_URL as string}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.EINVOICE_API_KEY as string}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.EINVOICE_TIMEOUT_MS),
      });
    } catch (error) {
      // Ag hatasi ve zaman asimi ayni yere duser: ikisi de GECICIDIR ve
      // ikisinde de belgenin karsi tarafa ulasip ulasmadigi BILINMEZ.
      throw new ProviderTransientError(
        `Entegratöre ulaşılamadı: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const metin = await response.text().catch(() => '');

    if (!response.ok) {
      const detay = metin.slice(0, 400);

      if (response.status === 429 || response.status >= 500) {
        throw new ProviderTransientError(`Entegratör ${response.status} döndü: ${detay}`);
      }

      throw new ProviderPermanentError(`Entegratör ${response.status} döndü: ${detay}`);
    }

    try {
      return metin.length > 0 ? (JSON.parse(metin) as Record<string, unknown>) : {};
    } catch {
      /* Basarili yanit ama okunamayan govde. Tekrar denemek ayni sonucu
         verecegi icin KALICIDIR; sessizce basarili saymak ise belgeyi
         izlenemez birakirdi. */
      throw new ProviderPermanentError('Entegratör yanıtı okunamadı (geçersiz JSON).');
    }
  }
}

/** Saglayicidan saglayiciya degisen alan adlari icin sirali okuma. */
function okuMetin(kaynak: Record<string, unknown>, adaylar: readonly string[]): string | null {
  for (const ad of adaylar) {
    const deger = kaynak[ad];
    if (typeof deger === 'string' && deger.trim().length > 0) return deger.trim();
    if (typeof deger === 'number') return String(deger);
  }

  return null;
}
