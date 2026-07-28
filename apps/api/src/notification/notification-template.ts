/**
 * ToptanPortal API - Bildirim Metinleri
 *
 * Metin uretimi SAF bir islevdir: veritabani, istek baglami veya saat okumaz.
 * Bunun sebebi test edilebilirlik degil, GONDERIM ANINDAN BAGIMSIZLIKTIR -
 * mesaj kuyruga yazilirken uretilir ve orada donar (bkz. NotificationMessage).
 *
 * KOR SIPARIS MODU BURADA UYGULANIR. `canSeeFinancials` false ise metne
 * hicbir parasal deger girmez. Bu, arayuzdeki gizlemenin tekrari degil
 * TAMAMLAYICISIDIR: ekranda ozenle gizlenen tutarin e-postayla posta
 * kutusuna dusmesi, gizlemeyi bastan anlamsiz kilar. Kural
 * `notification-template.spec.ts` ile kilitlenmistir.
 *
 * Metinler KISADIR ve konu satiri tek basina bilgi tasir: kullanicilarin
 * cogu bildirimi telefon kilit ekraninda gorur ve govdeyi hic acmaz.
 */

import {
  NotificationChannel,
  NotificationTopic,
  type NotificationChannel as Channel,
  type NotificationTopic as Topic,
} from '@toptanportal/contracts';

/** Mobil bildirim govdesi. Uzun metin cihazda zaten kirpilir. */
const PUSH_BODY_LIMIT = 160;

export interface RenderedNotification {
  subject: string;
  body: string;
}

export type NotificationPayload =
  | {
      topic: typeof NotificationTopic.ORDER_STATUS;
      orderNumber: string;
      statusLabel: string;
      companyTitle: string;
      grandTotal: number | null;
      currency: string;
      /** Reddedilme/iptal sebebi - varsa metnin en degerli parcasidir. */
      reason?: string | null;
    }
  | {
      topic: typeof NotificationTopic.ORDER_APPROVAL_PENDING;
      orderNumber: string;
      requestedByName: string;
      grandTotal: number | null;
      currency: string;
      lineCount: number;
    }
  | {
      topic: typeof NotificationTopic.PAYMENT_RECEIVED;
      amount: number;
      currency: string;
      methodLabel: string;
      companyTitle: string;
      /** Kapatilan belge - "hangi faturam kapandi" ilk sorulan sorudur. */
      documentNumber?: string | null;
    }
  | {
      topic: typeof NotificationTopic.DUE_DATE_REMINDER;
      documentNumber: string;
      dueDate: string;
      amount: number;
      currency: string;
      /** Negatifse vade henuz gelmemistir. */
      daysOverdue: number;
    }
  | {
      topic: typeof NotificationTopic.SECURITY;
      eventLabel: string;
      city?: string | null;
      ip?: string | null;
      occurredAt: string;
    }
  | {
      topic: typeof NotificationTopic.INTEGRATION_ALERT;
      channelLabel: string;
      detail: string;
    };

export interface RenderInput {
  payload: NotificationPayload;
  channel: Channel;
  recipientName: string;
  /**
   * Alicinin PRICE_VIEW yetkisi. Kor Siparis Modundaki kullanici icin false
   * gelir ve metinden TUM parasal degerler dusulur.
   */
  canSeeFinancials: boolean;
  webBaseUrl: string;
}

const MONEY_FORMATTER_CACHE = new Map<string, Intl.NumberFormat>();

/** "12.480,00 TL" - Turkce bicim. Tutari GORMEYE YETKILI alicilar icin. */
export function formatMoney(amount: number, currency: string): string {
  let formatter = MONEY_FORMATTER_CACHE.get(currency);

  if (!formatter) {
    formatter = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    MONEY_FORMATTER_CACHE.set(currency, formatter);
  }

  const suffix = currency === 'TRY' ? 'TL' : currency;
  return `${formatter.format(amount)} ${suffix}`;
}

export function formatDate(isoDate: string): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return isoDate;

  return new Intl.DateTimeFormat('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Europe/Istanbul',
  }).format(date);
}

export function renderNotification(input: RenderInput): RenderedNotification {
  const rendered = renderByTopic(input);

  if (input.channel === NotificationChannel.PUSH) {
    return {
      subject: rendered.subject,
      body: kisalt(tekSatir(rendered.body), PUSH_BODY_LIMIT),
    };
  }

  return rendered;
}

function renderByTopic(input: RenderInput): RenderedNotification {
  const { payload, canSeeFinancials, recipientName, webBaseUrl } = input;
  const selam = `Sayın ${recipientName},`;

  switch (payload.topic) {
    case NotificationTopic.ORDER_STATUS: {
      /* Tutar konu satirinda YER ALMAZ - konu satiri bildirim onizlemesinde,
         yani kilit ekraninda gorunur ve orasi omuz ustunden okunabilen bir
         yerdir. Tutar, yetki varsa govdede durur. */
      const subject = `${payload.orderNumber} numaralı siparişiniz: ${payload.statusLabel}`;

      const satirlar = [
        selam,
        '',
        `${payload.companyTitle} adına verdiğiniz ${payload.orderNumber} numaralı sipariş "${payload.statusLabel}" durumuna geçti.`,
      ];

      if (canSeeFinancials && payload.grandTotal !== null) {
        satirlar.push(`Sipariş tutarı: ${formatMoney(payload.grandTotal, payload.currency)}`);
      }

      if (payload.reason) {
        satirlar.push(`Açıklama: ${payload.reason}`);
      }

      satirlar.push('', `Siparişin ayrıntısı: ${webBaseUrl}/panel/siparisler`);

      return { subject, body: satirlar.join('\n') };
    }

    case NotificationTopic.ORDER_APPROVAL_PENDING: {
      const subject = `Onayınızı bekleyen sipariş: ${payload.orderNumber}`;

      const satirlar = [
        selam,
        '',
        `${payload.requestedByName}, ${payload.lineCount} kalemlik ${payload.orderNumber} numaralı siparişi onayınıza gönderdi.`,
      ];

      if (canSeeFinancials && payload.grandTotal !== null) {
        satirlar.push(`Sipariş tutarı: ${formatMoney(payload.grandTotal, payload.currency)}`);
      }

      /* Bekleyen siparisin stogu REZERVEDIR: onay gecikmesi yalnizca o
         siparisi degil, ayni urunu isteyen diger bayileri de bekletir.
         Bunu yazmak, hatirlatmanin isini yapar. */
      satirlar.push(
        '',
        'Onay bekleyen siparişin stoğu rezerve tutulur; onaylanana kadar bu ürünler başka siparişe açılmaz.',
        `Onay ekranı: ${webBaseUrl}/panel/onaylar`,
      );

      return { subject, body: satirlar.join('\n') };
    }

    case NotificationTopic.PAYMENT_RECEIVED: {
      /* Tahsilat bildirimi tutarsiz anlamsizdir; yetkisi olmayan aliciya bu
         konu zaten hic uretilmez (bkz. NotificationService.olusturulacakAlicilar). */
      const subject = `Tahsilatınız işlendi: ${formatMoney(payload.amount, payload.currency)}`;

      const satirlar = [
        selam,
        '',
        `${payload.companyTitle} hesabınıza ${formatMoney(payload.amount, payload.currency)} tutarında ${payload.methodLabel} tahsilatı işlendi.`,
      ];

      if (payload.documentNumber) {
        satirlar.push(`Kapatılan belge: ${payload.documentNumber}`);
      }

      satirlar.push('', `Hesap ekstreniz: ${webBaseUrl}/panel/ekstre`);

      return { subject, body: satirlar.join('\n') };
    }

    case NotificationTopic.DUE_DATE_REMINDER: {
      const gecmis = payload.daysOverdue > 0;

      /* Vadesi GELMEMIS belge icin "gecikti" demek, odemesini gununde yapan
         bayiyi rencide eder ve hatirlatmanin tamamini guvenilmez kilar. */
      const subject = gecmis
        ? `Vadesi geçen belge: ${payload.documentNumber}`
        : `Vadesi yaklaşan belge: ${payload.documentNumber}`;

      const satirlar = [
        selam,
        '',
        gecmis
          ? `${payload.documentNumber} numaralı belgenin vadesi ${formatDate(payload.dueDate)} tarihinde doldu (${payload.daysOverdue} gün).`
          : `${payload.documentNumber} numaralı belgenin vadesi ${formatDate(payload.dueDate)} tarihinde doluyor.`,
        `Tutar: ${formatMoney(payload.amount, payload.currency)}`,
        '',
        `Ödeme ve ekstre: ${webBaseUrl}/panel/odeme`,
        '',
        /* Odeme ile bildirimin cakismasi kacinilmazdir: hatirlatma kuyruga
           girdikten sonra odeme gelebilir. Bunu yazmamak, odemesini yapmis
           bayiye bordro hatasi yapilmis gibi hissettirir. */
        'Ödemenizi bu bildirimden önce yaptıysanız lütfen dikkate almayınız.',
      ];

      return { subject, body: satirlar.join('\n') };
    }

    case NotificationTopic.SECURITY: {
      const subject = `Hesap güvenliği: ${payload.eventLabel}`;

      const yer = [payload.city, payload.ip].filter(Boolean).join(' · ');

      return {
        subject,
        body: [
          selam,
          '',
          `Hesabınızda "${payload.eventLabel}" işlemi gerçekleşti.`,
          `Zaman: ${formatDate(payload.occurredAt)}`,
          yer.length > 0 ? `Konum: ${yer}` : null,
          '',
          /* Bu cumle bildirimin TEK amacidir: bilgi vermek degil, yanlissa
             harekete gecirmek. */
          'Bu işlemi siz yapmadıysanız şifrenizi hemen değiştirin ve açık oturumlarınızı sonlandırın:',
          `${webBaseUrl}/panel/guvenlik`,
        ]
          .filter((satir): satir is string => satir !== null)
          .join('\n'),
      };
    }

    case NotificationTopic.INTEGRATION_ALERT: {
      return {
        subject: `Entegrasyon uyarısı: ${payload.channelLabel}`,
        body: [
          selam,
          '',
          `${payload.channelLabel} kanalında müdahale gerektiren bir durum var.`,
          payload.detail,
          '',
          `Entegrasyon durumu: ${webBaseUrl}/panel/entegrasyon`,
        ].join('\n'),
      };
    }
  }
}

function tekSatir(metin: string): string {
  return metin.replace(/\s*\n\s*/g, ' ').trim();
}

function kisalt(metin: string, limit: number): string {
  return metin.length <= limit ? metin : `${metin.slice(0, limit - 1).trimEnd()}…`;
}

/** Konu bazli varsayilan kanal seti. Kullanici tercihi bunun uzerine yazar. */
export const DEFAULT_CHANNELS: Record<Topic, readonly Channel[]> = {
  [NotificationTopic.ORDER_STATUS]: [NotificationChannel.EMAIL, NotificationChannel.PUSH],
  [NotificationTopic.ORDER_APPROVAL_PENDING]: [
    NotificationChannel.EMAIL,
    NotificationChannel.PUSH,
  ],
  [NotificationTopic.PAYMENT_RECEIVED]: [NotificationChannel.EMAIL],
  [NotificationTopic.DUE_DATE_REMINDER]: [NotificationChannel.EMAIL],
  /* Guvenlik bildirimi HER KANALDAN gider: saldirgan bir kanali ele
     gecirmis olabilir ve ikinci kanal tek uyari sansidir. */
  [NotificationTopic.SECURITY]: [NotificationChannel.EMAIL, NotificationChannel.PUSH],
  [NotificationTopic.INTEGRATION_ALERT]: [NotificationChannel.EMAIL],
};
