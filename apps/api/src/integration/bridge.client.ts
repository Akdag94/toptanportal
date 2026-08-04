/**
 * ToptanPortal API - Logo Kopru Istemcisi
 *
 * Sirket ici koprüye giden TEK kapi. Baglanti karsilikli sertifika dogrulamasi
 * (mTLS) ile kurulur: kopru yalnizca bu sertifikayi sunan istemciyi kabul eder,
 * bulut da yalnizca kendi CA'siyla imzalanmis kopruye baglanir. Jeton tabanli
 * bir kimlik, sizdiginda her yerden kullanilabilir; istemci sertifikasi ise
 * sunucudaki dosyaya bagli kalir.
 *
 * HATA SINIFLANDIRMASI bu dosyanin asil isidir:
 *
 *   * Ag / zaman asimi / 5xx  -> GECICI. Tekrar denenir, olay kuyrukta kalir.
 *   * 4xx is kurali hatasi    -> KALICI. Tekrar denemek ayni sonucu verir;
 *                                olay olu isaretlenir ve operatore dusulur.
 *
 * Bu ayrim yapilmazsa iki kotu sonuctan biri kacinilmazdir: kalici hata sonsuz
 * denenip kuyrugu tikar, ya da gecici hata pes edip siparisi kaybeder.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { Agent, request as httpsRequest } from 'node:https';
import {
  BridgeRejectionReason,
  accountDeltaPageSchema,
  bridgeErrorSchema,
  bridgeHealthSchema,
  bridgeItemResultSchema,
  bridgeOrderResultSchema,
  bridgePriceResultSchema,
  priceDeltaPageSchema,
  stockDeltaPageSchema,
  type AccountDeltaPage,
  type BridgeHealth,
  type BridgeItemPush,
  type BridgeItemResult,
  type BridgeOrderPush,
  type BridgeOrderResult,
  type BridgePricePush,
  type BridgePriceResult,
  type PriceDeltaPage,
  type StockDeltaPage,
} from '@toptanportal/contracts';
import type { ZodSchema } from 'zod';

import type { AppConfig } from '../config/configuration';

/** Tekrar denenmesi ANLAMLI olan hata. Olay kuyrukta kalir. */
export class BridgeTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeTransientError';
  }
}

/** Tekrar denendiginde ayni sonucu verecek hata. Olay olu isaretlenir. */
export class BridgePermanentError extends Error {
  readonly reason: BridgeRejectionReason;
  readonly offendingCode: string | null;

  constructor(reason: BridgeRejectionReason, message: string, offendingCode: string | null) {
    super(message);
    this.name = 'BridgePermanentError';
    this.reason = reason;
    this.offendingCode = offendingCode;
  }
}

interface BridgeRequestOptions {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  /** Yanit govdesinin dogrulanacagi sema. */
  schema: ZodSchema;
  /** Varsayilan zaman asimini asan cagrilar icin (or. tam senkron). */
  timeoutMs?: number;
}

@Injectable()
export class BridgeClient {
  private readonly logger = new Logger(BridgeClient.name);
  private readonly config: AppConfig;
  private readonly agent: Agent | null;

  constructor(configService: ConfigService) {
    this.config = configService.getOrThrow<AppConfig>('app');
    this.agent = this.createAgent();
  }

  /** Kopru yapilandirilmadiysa entegrasyon sessizce devre disidir. */
  get isConfigured(): boolean {
    return this.config.LOGO_BRIDGE_BASE_URL !== undefined && this.agent !== null;
  }

  /**
   * Sertifikalar SURECIN ACILISINDA okunur. Her istekte diskten okumak, dosya
   * degistiginde davranisi belirsizlestirir; sertifika yenilendiginde surec
   * yeniden baslatilir - bu bilincli ve gozlemlenebilir bir islemdir.
   */
  private createAgent(): Agent | null {
    const { LOGO_BRIDGE_CLIENT_CERT_PATH, LOGO_BRIDGE_CLIENT_KEY_PATH, LOGO_BRIDGE_CA_PATH } =
      this.config;

    if (
      this.config.LOGO_BRIDGE_BASE_URL === undefined ||
      LOGO_BRIDGE_CLIENT_CERT_PATH === undefined ||
      LOGO_BRIDGE_CLIENT_KEY_PATH === undefined
    ) {
      this.logger.warn(
        'Logo köprüsü yapılandırılmadı; entegrasyon kanalları devre dışı çalışacak.',
      );
      return null;
    }

    try {
      return new Agent({
        cert: readFileSync(LOGO_BRIDGE_CLIENT_CERT_PATH),
        key: readFileSync(LOGO_BRIDGE_CLIENT_KEY_PATH),
        ca: LOGO_BRIDGE_CA_PATH ? readFileSync(LOGO_BRIDGE_CA_PATH) : undefined,
        /* Sunucu dogrulamasi ASLA kapatilmaz. Kapatildiginda mTLS'in yarisi -
           koprunun kimligi - dogrulanmamis olur ve tunel, araya girene karsi
           korumasiz kalir. */
        rejectUnauthorized: true,
        /* Baglanti havuzu: kopruye yapilan cagrilar sik ve kucuktur; her
           cagrida yeni TLS el sikismasi, gecikmenin buyuk kismini olusturur. */
        keepAlive: true,
        maxSockets: 8,
      });
    } catch (error) {
      this.logger.error(
        `Köprü sertifikaları okunamadı: ${error instanceof Error ? error.message : 'bilinmeyen hata'}`,
      );
      return null;
    }
  }

  private async call<TResponse>(options: BridgeRequestOptions): Promise<TResponse> {
    if (!this.isConfigured || this.agent === null) {
      throw new BridgeTransientError('Logo köprüsü yapılandırılmamış.');
    }

    const url = `${this.config.LOGO_BRIDGE_BASE_URL?.replace(/\/$/, '')}${options.path}`;
    const { status, text } = await this.send(
      url,
      options,
      options.timeoutMs ?? this.config.LOGO_BRIDGE_TIMEOUT_MS,
    );

    if (status >= 500 || status === 429) {
      throw new BridgeTransientError(
        `Köprü geçici hata döndü (HTTP ${status}): ${text.slice(0, 300)}`,
      );
    }

    if (status >= 400) {
      throw this.toPermanentError(status, text);
    }

    let payload: unknown;

    try {
      payload = JSON.parse(text);
    } catch {
      throw new BridgeTransientError('Köprüden geçersiz JSON yanıtı alındı.');
    }

    const parsed = options.schema.safeParse(payload);

    if (!parsed.success) {
      /* Sema uyumsuzlugu KALICIDIR: kopru surumu ile bulut surumu ayrismistir,
         tekrar denemek ayni yaniti getirir. Protokol uyusmazligini gecici hata
         sayarsak kuyruk sessizce buyur ve kimse surum farkini fark etmez. */
      throw new BridgePermanentError(
        BridgeRejectionReason.VALIDATION_FAILED,
        `Köprü yanıtı beklenen sözleşmeye uymuyor: ${parsed.error.issues[0]?.message ?? 'bilinmeyen alan'}`,
        null,
      );
    }

    return parsed.data as TResponse;
  }

  /**
   * Ham HTTPS cagrisi. `fetch` yerine `node:https` kullanilir cunku Node'un
   * fetch'i istemci sertifikasi tasiyan bir ajan kabul etmez; mTLS'in tek
   * yolu budur.
   *
   * Zaman asimi soketin uzerinde kurulur ve istek ETKIN sekilde iptal edilir:
   * yalnizca bekleyip vazgecmek, sunucu tarafinda yarim kalan bir istek birakir
   * ve siparis yazimi soz konusuysa "gonderdim mi?" belirsizligini uretir.
   */
  private send(
    url: string,
    options: BridgeRequestOptions,
    timeoutMs: number,
  ): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const govde = options.body === undefined ? null : JSON.stringify(options.body);

      const istek = httpsRequest(
        url,
        {
          method: options.method,
          agent: this.agent ?? undefined,
          headers: {
            Accept: 'application/json',
            ...(govde === null
              ? {}
              : {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(govde),
                }),
          },
        },
        (yanit) => {
          const parcalar: Buffer[] = [];
          yanit.on('data', (parca: Buffer) => parcalar.push(parca));
          yanit.on('end', () =>
            resolve({
              status: yanit.statusCode ?? 0,
              text: Buffer.concat(parcalar).toString('utf8'),
            }),
          );
        },
      );

      istek.setTimeout(timeoutMs, () => {
        istek.destroy(new Error(`Köprü ${timeoutMs} ms içinde yanıt vermedi.`));
      });

      istek.on('error', (error) => {
        /* Ag hatasi, DNS, TLS el sikismasi ve zaman asimi ayni kovaya duser:
           hepsi tekrar denendiginde basarili olabilir. */
        reject(new BridgeTransientError(`Köprüye ulaşılamadı: ${error.message}`));
      });

      if (govde !== null) istek.write(govde);
      istek.end();
    });
  }

  private toPermanentError(status: number, body: string): BridgePermanentError {
    try {
      const parsed = bridgeErrorSchema.safeParse(JSON.parse(body));

      if (parsed.success) {
        return new BridgePermanentError(
          parsed.data.reason,
          parsed.data.message,
          parsed.data.offendingCode,
        );
      }
    } catch {
      // Govde okunamadi; asagidaki genel hataya duselim.
    }

    return new BridgePermanentError(
      BridgeRejectionReason.VALIDATION_FAILED,
      `Köprü isteği reddetti (HTTP ${status}): ${body.slice(0, 300)}`,
      null,
    );
  }

  // -------------------------------------------------------------------------
  // Protokol yuzeyi
  // -------------------------------------------------------------------------

  health(): Promise<BridgeHealth> {
    return this.call<BridgeHealth>({
      method: 'GET',
      path: '/bridge/v1/health',
      schema: bridgeHealthSchema,
      /* Saglik yoklamasi kisa tutulur: yavas bir kopru, saglikli sayilmamalidir
         ve yoklamanin kendisi isleyiciyi bekletmemelidir. */
      timeoutMs: 2000,
    });
  }

  stockDelta(cursor: string, limit: number): Promise<StockDeltaPage> {
    return this.call<StockDeltaPage>({
      method: 'GET',
      path: `/bridge/v1/stock?cursor=${encodeURIComponent(cursor)}&limit=${limit}`,
      schema: stockDeltaPageSchema,
    });
  }

  priceDelta(cursor: string, limit: number): Promise<PriceDeltaPage> {
    return this.call<PriceDeltaPage>({
      method: 'GET',
      path: `/bridge/v1/prices?cursor=${encodeURIComponent(cursor)}&limit=${limit}`,
      schema: priceDeltaPageSchema,
    });
  }

  accountDelta(cursor: string, limit: number): Promise<AccountDeltaPage> {
    return this.call<AccountDeltaPage>({
      method: 'GET',
      path: `/bridge/v1/accounts?cursor=${encodeURIComponent(cursor)}&limit=${limit}`,
      schema: accountDeltaPageSchema,
    });
  }

  /**
   * Siparisi Logo'ya aktarir. `portalOrderId` idempotency anahtaridir: ayni
   * kimlikle ikinci cagri yeni siparis acmaz, ilk sonucu doner. Bu yuzden ag
   * zaman asiminda tekrar denemek GUVENLIDIR - ki dispatcher tam bunu yapar.
   */
  pushOrder(order: BridgeOrderPush): Promise<BridgeOrderResult> {
    return this.call<BridgeOrderResult>({
      method: 'POST',
      path: '/bridge/v1/orders',
      body: order,
      schema: bridgeOrderResultSchema,
      /* Siparis yazimi Logo tarafinda fis olusturur; okuma cagrilarindan
         belirgin sekilde uzun surer. */
      timeoutMs: Math.max(this.config.LOGO_BRIDGE_TIMEOUT_MS, 15000),
    });
  }

  /**
   * Stok kartini Logo'ya yazar. Idempotency anahtari STOK KODUDUR: ayni kodla
   * ikinci cagri yeni kart acmaz, var olani gunceller.
   *
   * Bu, siparisteki `portalOrderId` anahtarindan farkli bir gerekceyle
   * dogrudur: siparis her cagrida yeni bir belge olabilirdi, kart olamaz -
   * kod zaten Logo'nun birincil anahtaridir. Ag zaman asiminda tekrar denemek
   * bu yuzden guvenlidir.
   */
  pushItem(item: BridgeItemPush): Promise<BridgeItemResult> {
    return this.call<BridgeItemResult>({
      method: 'POST',
      path: '/bridge/v1/items',
      body: item,
      schema: bridgeItemResultSchema,
      timeoutMs: Math.max(this.config.LOGO_BRIDGE_TIMEOUT_MS, 15000),
    });
  }

  /**
   * Fiyati Logo'ya yazar. Anahtar kart + liste + birim bilesimidir.
   *
   * Kart yazimindan AYRI bir cagridir ve sirasi onemlidir: kart once yazilir.
   * Ikisini tek cagriya birlestirmek, fiyat reddedildiginde kartin da
   * yazilmamis sayilmasina yol acardi - oysa kart Logo'da acilmistir ve
   * portalin onu tekrar acmaya calismasi gereksizdir.
   */
  pushPrice(price: BridgePricePush): Promise<BridgePriceResult> {
    return this.call<BridgePriceResult>({
      method: 'POST',
      path: '/bridge/v1/prices',
      body: price,
      schema: bridgePriceResultSchema,
      timeoutMs: Math.max(this.config.LOGO_BRIDGE_TIMEOUT_MS, 15000),
    });
  }
}
