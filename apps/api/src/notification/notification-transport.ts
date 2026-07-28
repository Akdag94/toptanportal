/**
 * ToptanPortal API - Bildirim Tasima Katmani
 *
 * Kuyruk ile saglayici arasindaki TEK kapi. Kuyruk, mesajin e-posta mi mobil
 * bildirim mi oldugunu bilir; nasil gonderildigini bilmez. SMTP kullanmak
 * isteyen kurulum yalnizca bu arayuzu uygular ve kuyrugun tek satiri
 * degismez.
 *
 * HATA SINIFLANDIRMASI kopru istemcisiyle AYNI mantiktadir ve ayni sebeple
 * onemlidir:
 *
 *   * Ag / zaman asimi / 5xx        -> GECICI. Tekrar denenir.
 *   * 4xx (gecersiz adres, red)     -> KALICI. Tekrar denemek ayni sonucu
 *                                      verir; kayit basarisiz isaretlenir.
 *
 * Gecersiz bir e-posta adresini alti kez denemek, saglayici nezdinde gonderen
 * itibarini dusurur - o itibar dustugunde GECERLI adreslere giden mesajlar da
 * istenmeyen klasorune duser. Yani sinifladirma yapmamak, calisan bildirimleri
 * de bozar.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationChannel } from '@toptanportal/contracts';

import type { AppConfig } from '../config/configuration';

/** Tekrar denenmesi ANLAMLI hata. */
export class TransportTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportTransientError';
  }
}

/** Tekrar denendiginde ayni sonucu verecek hata. */
export class TransportPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportPermanentError';
  }
}

export interface OutboundMessage {
  recipient: string;
  recipientName: string | null;
  subject: string;
  body: string;
}

export interface NotificationTransport {
  readonly channel: NotificationChannel;
  /** false ise kanal kapali kabul edilir; mesaj "gönderilmedi" olarak kapanir. */
  readonly configured: boolean;
  send(message: OutboundMessage): Promise<void>;
}

/**
 * Saglayicinin HTTP ucuna POST eder.
 *
 * Govde saglayiciya gore degisir; degisen tek sey bu iki sinifin `payload`
 * uretimidir. Kimlik bilgisi, zaman asimi ve hata siniflandirmasi ortak
 * kalir - uc kanal icin uc kez yazilmis bir zaman asimi, ucunde de farkli
 * davranir.
 */
abstract class HttpTransport implements NotificationTransport {
  protected readonly logger = new Logger(this.constructor.name);

  abstract readonly channel: NotificationChannel;
  abstract readonly configured: boolean;

  protected abstract endpoint(): string;
  protected abstract apiKey(): string;
  protected abstract payload(message: OutboundMessage): unknown;
  protected abstract timeoutMs(): number;

  async send(message: OutboundMessage): Promise<void> {
    if (!this.configured) {
      throw new TransportPermanentError(`${this.channel} kanalı yapılandırılmadı.`);
    }

    let response: Response;

    try {
      response = await fetch(this.endpoint(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey()}`,
        },
        body: JSON.stringify(this.payload(message)),
        signal: AbortSignal.timeout(this.timeoutMs()),
      });
    } catch (error) {
      // Ag hatasi ve zaman asimi ayni yere duser: ikisi de GECICIDIR.
      throw new TransportTransientError(
        `Sağlayıcıya ulaşılamadı: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (response.ok) return;

    const detay = (await response.text().catch(() => '')).slice(0, 300);

    /* 429 bir 4xx'tir ama KALICI DEGILDIR: saglayici "sonra tekrar dene"
       diyor. Bunu kalici saymak, yogun saatte uretilen tum bildirimleri
       cope atmak olurdu. */
    if (response.status === 429 || response.status >= 500) {
      throw new TransportTransientError(`Sağlayıcı ${response.status} döndü: ${detay}`);
    }

    throw new TransportPermanentError(`Sağlayıcı ${response.status} döndü: ${detay}`);
  }
}

@Injectable()
export class MailTransport extends HttpTransport {
  readonly channel = NotificationChannel.EMAIL;
  readonly configured: boolean;

  private readonly config: AppConfig;

  constructor(configService: ConfigService) {
    super();
    this.config = configService.getOrThrow<AppConfig>('app');
    this.configured = Boolean(
      this.config.MAIL_API_URL && this.config.MAIL_API_KEY && this.config.MAIL_FROM,
    );

    if (!this.configured) {
      /* Gelistirme ortaminda bu normaldir; uretimde uygulama zaten acilmaz
         (bkz. configuration.ts). Yine de sessiz kalmamali: "e-posta gelmiyor"
         sikayetinin cevabi bu satirdir. */
      this.logger.warn(
        'E-posta sağlayıcısı yapılandırılmadı (MAIL_API_URL / MAIL_API_KEY / MAIL_FROM). ' +
          'Bildirimler kuyruğa yazılır ancak GÖNDERİLMEZ.',
      );
    }
  }

  protected endpoint(): string {
    return this.config.MAIL_API_URL as string;
  }

  protected apiKey(): string {
    return this.config.MAIL_API_KEY as string;
  }

  protected timeoutMs(): number {
    return this.config.MAIL_TIMEOUT_MS;
  }

  protected payload(message: OutboundMessage): unknown {
    return {
      from: { email: this.config.MAIL_FROM, name: this.config.MAIL_FROM_NAME },
      to: [{ email: message.recipient, name: message.recipientName ?? undefined }],
      subject: message.subject,
      text: message.body,
    };
  }
}

@Injectable()
export class PushTransport extends HttpTransport {
  readonly channel = NotificationChannel.PUSH;
  readonly configured: boolean;

  private readonly config: AppConfig;

  constructor(configService: ConfigService) {
    super();
    this.config = configService.getOrThrow<AppConfig>('app');
    this.configured = Boolean(this.config.PUSH_API_URL && this.config.PUSH_API_KEY);
  }

  protected endpoint(): string {
    return this.config.PUSH_API_URL as string;
  }

  protected apiKey(): string {
    return this.config.PUSH_API_KEY as string;
  }

  protected timeoutMs(): number {
    return this.config.MAIL_TIMEOUT_MS;
  }

  protected payload(message: OutboundMessage): unknown {
    /* Alici burada cihaz JETONUDUR. Jeton kayitta acik durmaz; kuyruk
       kaydinda ozeti tutulur (bkz. NotificationService). */
    return {
      token: message.recipient,
      title: message.subject,
      body: message.body,
    };
  }
}
