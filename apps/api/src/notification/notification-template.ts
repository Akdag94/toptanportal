/**
 * ToptanPortal API - Bildirim Metinleri
 *
 * Metin uretimi SAF bir islevdir: veritabani, istek baglami veya saat okumaz.
 * Bunun sebebi test edilebilirlik degil, GONDERIM ANINDAN BAGIMSIZLIKTIR -
 * mesaj kuyruga yazilirken uretilir ve orada donar (bkz. NotificationMessage).
 *
 * URETIM IKI ADIMDIR:
 *
 *   1. Yuke ve ALICIYA gore bir DEGISKEN SOZLUGU kurulur. Parasal degerler,
 *      yalnizca alicinin gorme yetkisi varsa sozluge girer.
 *   2. Sablon metnindeki {{degisken}} yerlerine sozlukteki degerler konur.
 *      Degeri OLMAYAN bir degisken iceren SATIRIN TAMAMI dusurulur.
 *
 * KOR SIPARIS MODU bu ikinci adimda uygulanir ve mekanizmasi kiraci sablonlari
 * icin de aynidir: kiraci "Sipariş tutarı: {{tutar}}" yazsa bile, fiyat
 * gormeyen aliciya giden metinde o satir HIC BULUNMAZ. Bu, arayuzdeki
 * gizlemenin tekrari degil TAMAMLAYICISIDIR: ekranda ozenle gizlenen tutarin
 * e-postayla posta kutusuna dusmesi, gizlemeyi bastan anlamsiz kilar. Kural
 * `notification-template.spec.ts` ile kilitlenmistir.
 *
 * Metinler KISADIR ve konu satiri tek basina bilgi tasir: kullanicilarin
 * cogu bildirimi telefon kilit ekraninda gorur ve govdeyi hic acmaz.
 */

import {
  NotificationChannel,
  NotificationTopic,
  extractPlaceholders,
  type NotificationChannel as Channel,
  type NotificationTopic as Topic,
} from '@toptanportal/contracts';

/** Mobil bildirim govdesi. Uzun metin cihazda zaten kirpilir. */
const PUSH_BODY_LIMIT = 160;

export interface RenderedNotification {
  subject: string;
  body: string;
}

/** Ham sablon metni - {{degisken}} tasir. */
export interface TemplateSource {
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
  /**
   * Kiracinin uzerine yazdigi metin. Verilmezse kodda duran varsayilan
   * kullanilir - varsayilan da ayni motordan gecer, boylece kiraci metni
   * "ikinci sinif" bir yol izlemez.
   */
  template?: TemplateSource | null;
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

// ---------------------------------------------------------------------------
// Varsayilan metinler
// ---------------------------------------------------------------------------

/**
 * Kodda duran metinler. Kiraci bunlarin UZERINE yazar; sablonunu silmek
 * buraya doner.
 *
 * PUSH icin ayri bir varsayilan YOKTUR: ayni metin tek satira indirilip
 * kisaltilir. Iki ayri varsayilan metin, birinde yapilan duzeltmenin
 * digerinde unutulmasi demektir. Kiraci isterse kanal bazinda ayri sablon
 * tanimlayabilir.
 */
export const DEFAULT_TEMPLATES: Record<Topic, TemplateSource> = {
  [NotificationTopic.ORDER_STATUS]: {
    /* Tutar konu satirinda YER ALMAZ - konu satiri bildirim onizlemesinde,
       yani kilit ekraninda gorunur ve orasi omuz ustunden okunabilen bir
       yerdir. Tutar, yetki varsa govdede durur. */
    subject: '{{siparisNo}} numaralı siparişiniz: {{durum}}',
    body: [
      'Sayın {{alici}},',
      '',
      '{{isletme}} adına verdiğiniz {{siparisNo}} numaralı sipariş "{{durum}}" durumuna geçti.',
      'Sipariş tutarı: {{tutar}}',
      'Açıklama: {{aciklama}}',
      '',
      'Siparişin ayrıntısı: {{siparisBaglantisi}}',
    ].join('\n'),
  },

  [NotificationTopic.ORDER_APPROVAL_PENDING]: {
    subject: 'Onayınızı bekleyen sipariş: {{siparisNo}}',
    body: [
      'Sayın {{alici}},',
      '',
      '{{gonderen}}, {{kalemSayisi}} kalemlik {{siparisNo}} numaralı siparişi onayınıza gönderdi.',
      'Sipariş tutarı: {{tutar}}',
      '',
      /* Bekleyen siparisin stogu REZERVEDIR: onay gecikmesi yalnizca o
         siparisi degil, ayni urunu isteyen diger bayileri de bekletir.
         Bunu yazmak, hatirlatmanin isini yapar. */
      'Onay bekleyen siparişin stoğu rezerve tutulur; onaylanana kadar bu ürünler başka siparişe açılmaz.',
      'Onay ekranı: {{onayBaglantisi}}',
    ].join('\n'),
  },

  [NotificationTopic.PAYMENT_RECEIVED]: {
    /* Tahsilat bildirimi tutarsiz anlamsizdir; yetkisi olmayan aliciya bu
       konu zaten hic uretilmez (bkz. NotificationService.aliciUygunMu). Bu
       yuzden burada tutar konu satirinda da durabilir. */
    subject: 'Tahsilatınız işlendi: {{tutar}}',
    body: [
      'Sayın {{alici}},',
      '',
      '{{isletme}} hesabınıza {{tutar}} tutarında {{yontem}} tahsilatı işlendi.',
      'Kapatılan belge: {{belgeNo}}',
      '',
      'Hesap ekstreniz: {{ekstreBaglantisi}}',
    ].join('\n'),
  },

  [NotificationTopic.DUE_DATE_REMINDER]: {
    /* Vadesi GELMEMIS belge icin "gecikti" demek, odemesini gununde yapan
       bayiyi rencide eder ve hatirlatmanin tamamini guvenilmez kilar; bu
       yuzden durum bir DEGISKENDIR, sablonda kosul yoktur. */
    subject: 'Vadesi {{vadeDurumu}} belge: {{belgeNo}}',
    body: [
      'Sayın {{alici}},',
      '',
      '{{vadeCumlesi}}',
      'Tutar: {{tutar}}',
      '',
      'Ödeme ve ekstre: {{odemeBaglantisi}}',
      '',
      /* Odeme ile bildirimin cakismasi kacinilmazdir: hatirlatma kuyruga
         girdikten sonra odeme gelebilir. Bunu yazmamak, odemesini yapmis
         bayiye bordro hatasi yapilmis gibi hissettirir. */
      'Ödemenizi bu bildirimden önce yaptıysanız lütfen dikkate almayınız.',
    ].join('\n'),
  },

  [NotificationTopic.SECURITY]: {
    subject: 'Hesap güvenliği: {{olay}}',
    body: [
      'Sayın {{alici}},',
      '',
      'Hesabınızda "{{olay}}" işlemi gerçekleşti.',
      'Zaman: {{zaman}}',
      'Konum: {{konum}}',
      '',
      /* Bu cumle bildirimin TEK amacidir: bilgi vermek degil, yanlissa
         harekete gecirmek. */
      'Bu işlemi siz yapmadıysanız şifrenizi hemen değiştirin ve açık oturumlarınızı sonlandırın:',
      '{{guvenlikBaglantisi}}',
    ].join('\n'),
  },

  [NotificationTopic.INTEGRATION_ALERT]: {
    subject: 'Entegrasyon uyarısı: {{kanal}}',
    body: [
      'Sayın {{alici}},',
      '',
      '{{kanal}} kanalında müdahale gerektiren bir durum var.',
      '{{ayrinti}}',
      '',
      'Entegrasyon durumu: {{entegrasyonBaglantisi}}',
    ].join('\n'),
  },
};

// ---------------------------------------------------------------------------
// Degisken sozlugu
// ---------------------------------------------------------------------------

export type TemplateVariables = Record<string, string>;

/**
 * Yuke ve aliciya gore degisken sozlugu.
 *
 * SOZLUGE GIRMEYEN DEGISKEN, METINDE DE BULUNMAZ. Parasal degerler yalnizca
 * `canSeeFinancials` true iken eklenir; bos dize olarak eklenmeleri
 * "Sipariş tutarı:" gibi yarim bir satir birakirdi.
 */
export function buildVariables(input: RenderInput): TemplateVariables {
  const { payload, canSeeFinancials, recipientName, webBaseUrl } = input;

  const ortak: TemplateVariables = {
    alici: recipientName,
    portalAdresi: webBaseUrl,
  };

  /** Parasal degeri yalnizca yetki varsa yazar. */
  const para = (tutar: number | null, currency: string): TemplateVariables =>
    canSeeFinancials && tutar !== null ? { tutar: formatMoney(tutar, currency) } : {};

  switch (payload.topic) {
    case NotificationTopic.ORDER_STATUS:
      return {
        ...ortak,
        siparisNo: payload.orderNumber,
        durum: payload.statusLabel,
        isletme: payload.companyTitle,
        ...para(payload.grandTotal, payload.currency),
        ...(payload.reason ? { aciklama: payload.reason } : {}),
        siparisBaglantisi: `${webBaseUrl}/panel/siparisler`,
      };

    case NotificationTopic.ORDER_APPROVAL_PENDING:
      return {
        ...ortak,
        siparisNo: payload.orderNumber,
        gonderen: payload.requestedByName,
        kalemSayisi: String(payload.lineCount),
        ...para(payload.grandTotal, payload.currency),
        onayBaglantisi: `${webBaseUrl}/panel/onaylar`,
      };

    case NotificationTopic.PAYMENT_RECEIVED:
      return {
        ...ortak,
        ...para(payload.amount, payload.currency),
        yontem: payload.methodLabel,
        isletme: payload.companyTitle,
        ...(payload.documentNumber ? { belgeNo: payload.documentNumber } : {}),
        ekstreBaglantisi: `${webBaseUrl}/panel/ekstre`,
      };

    case NotificationTopic.DUE_DATE_REMINDER: {
      const gecmis = payload.daysOverdue > 0;
      const tarih = formatDate(payload.dueDate);

      return {
        ...ortak,
        belgeNo: payload.documentNumber,
        vadeTarihi: tarih,
        vadeDurumu: gecmis ? 'geçen' : 'yaklaşan',
        vadeCumlesi: gecmis
          ? `${payload.documentNumber} numaralı belgenin vadesi ${tarih} tarihinde doldu (${payload.daysOverdue} gün).`
          : `${payload.documentNumber} numaralı belgenin vadesi ${tarih} tarihinde doluyor.`,
        ...para(payload.amount, payload.currency),
        odemeBaglantisi: `${webBaseUrl}/panel/odeme`,
      };
    }

    case NotificationTopic.SECURITY: {
      const yer = [payload.city, payload.ip].filter(Boolean).join(' · ');

      return {
        ...ortak,
        olay: payload.eventLabel,
        zaman: formatDate(payload.occurredAt),
        ...(yer.length > 0 ? { konum: yer } : {}),
        guvenlikBaglantisi: `${webBaseUrl}/panel/guvenlik`,
      };
    }

    case NotificationTopic.INTEGRATION_ALERT:
      return {
        ...ortak,
        kanal: payload.channelLabel,
        ayrinti: payload.detail,
        entegrasyonBaglantisi: `${webBaseUrl}/panel/entegrasyon`,
      };
  }
}

// ---------------------------------------------------------------------------
// Sablon motoru
// ---------------------------------------------------------------------------

export interface AppliedTemplate {
  /** Cozulemeyen degisken varsa null - cagiran taraf varsayilana doner. */
  subject: string | null;
  body: string;
  droppedLineCount: number;
}

/**
 * Sablonu degisken sozluguyle uygular.
 *
 * MOTOR KASITLI OLARAK APTALDIR: kosul, dongu ve islev yoktur. Kullanicinin
 * duzenledigi bir metne mantik tasimak, o mantigin hatasini GONDERILMIS bir
 * iletide ortaya cikarir - geri alinamayan tek islemde.
 *
 * Govdede degeri olmayan bir degisken gecen satir DUSURULUR; konuda ise satir
 * diye bir sey yoktur, bu yuzden null donulur ve cagiran taraf varsayilana
 * duser. Bos konu satirli bir e-posta, gonderilmemis bir e-postadan kotudur.
 */
export function applyTemplate(
  source: TemplateSource,
  variables: TemplateVariables,
): AppliedTemplate {
  let dusen = 0;

  const satirlar = source.body.split('\n').filter((satir) => {
    const eksik = extractPlaceholders(satir).some((ad) => variables[ad] === undefined);
    if (eksik) dusen += 1;
    return !eksik;
  });

  const govde = temizle(satirlar.map((satir) => degistir(satir, variables)).join('\n'));

  const konuEksik = extractPlaceholders(source.subject).some(
    (ad) => variables[ad] === undefined,
  );

  return {
    subject: konuEksik ? null : degistir(source.subject, variables).trim(),
    body: govde,
    droppedLineCount: dusen,
  };
}

export function renderNotification(input: RenderInput): RenderedNotification {
  const variables = buildVariables(input);
  const varsayilan = DEFAULT_TEMPLATES[input.payload.topic];

  const uygulanan = applyTemplate(input.template ?? varsayilan, variables);

  /* Kiraci sablonu cozulemeyen bir konu uretti veya govdenin TUM satirlari
     dusuruldu. Ikisi de yalnizca kiraci metninde olabilir - varsayilanlarda
     selamlama satiri her zaman cozulur. Bu durumda varsayilana donulur:
     bildirimin hic gitmemesi, eksik gitmesinden kotudur. */
  const geriDonus =
    uygulanan.subject === null || uygulanan.body.length === 0
      ? applyTemplate(varsayilan, variables)
      : null;

  const konu = uygulanan.subject ?? geriDonus?.subject ?? kalanlariSil(input.payload.topic);
  const govde = uygulanan.body.length > 0 ? uygulanan.body : (geriDonus?.body ?? konu);

  if (input.channel === NotificationChannel.PUSH) {
    return { subject: konu, body: kisalt(tekSatir(govde), PUSH_BODY_LIMIT) };
  }

  return { subject: konu, body: govde };
}

function degistir(metin: string, variables: TemplateVariables): string {
  return metin.replace(
    /\{\{\s*([A-Za-zÇĞİÖŞÜçğıöşü0-9_]+)\s*\}\}/g,
    (tam, ad: string) => variables[ad] ?? tam,
  );
}

/**
 * Son care: varsayilan konu bile cozulemediyse degiskenleri temizleyip konuyu
 * kisaltilmis haliyle dondurur. Buraya normalde girilmez; girilirse de
 * kullaniciya bos konulu bir ileti gitmemis olur.
 */
function kalanlariSil(topic: Topic): string {
  return DEFAULT_TEMPLATES[topic].subject
    .replace(/\{\{\s*[A-Za-zÇĞİÖŞÜçğıöşü0-9_]+\s*\}\}/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[:\-·]\s*$/, '')
    .trim();
}

/** Dusen satirlarin ardinda kalan bosluklari toparlar. */
function temizle(metin: string): string {
  return metin.replace(/\n{3,}/g, '\n\n').trim();
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
