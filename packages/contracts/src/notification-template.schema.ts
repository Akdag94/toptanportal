/**
 * ToptanPortal - Bildirim Sablonu Sozlesmeleri
 *
 * Metinler koda gomulu oldugu surece "siparis onaylandi" cumlesini degistirmek
 * bir surum cikarmayi gerektirir; kiracinin kendi diliyle konusmasi ise
 * kurulumdan kurulusa degisen bir istektir. Sablon yonetimi bu ikisini ayirir:
 * VARSAYILAN metin kodda kalir, kiraci yalnizca UZERINE YAZAR ve satiri
 * silmek varsayilana doner.
 *
 * SABLON MOTORU KASITLI OLARAK APTALDIR. Kosul, dongu, islev cagrisi yoktur;
 * yalnizca {{degisken}} yerine deger konur. Sablon dili, kullanicinin
 * duzenledigi bir metne mantik tasimaktir ve o mantigin hatasi gonderilmis bir
 * iletide ortaya cikar - geri alinamayan tek islemde.
 *
 * KOR SIPARIS MODU BU KATMANDA DA GECERLIDIR ve mekanizmasi sudur:
 *
 *   Parasal degisken, gormeye yetkisi olmayan alici icin URETILMEZ; degeri
 *   olmayan bir degisken iceren SATIRIN TAMAMI dusurulur.
 *
 * Yani kiraci "Sipariş tutarı: {{tutar}}" yazsa bile, kor moddaki aliciya
 * giden metinde o satir hic bulunmaz. Degiskeni bos dizeyle degistirmek
 * "Siparis tutari:" gibi bir satir birakirdi; satiri dusurmek, sablonu yazan
 * kisinin bir hatasinin sizintiya donusmesini engeller. Kural
 * `notification-template.spec.ts` ile kilitlenmistir.
 */

import { z } from 'zod';

import { NotificationChannel, NotificationTopic } from './notification.schema';

// ---------------------------------------------------------------------------
// Degiskenler
// ---------------------------------------------------------------------------

export interface TemplateVariable {
  /** Sablonda {{key}} olarak yazilir. */
  key: string;
  label: string;
  /**
   * Parasal deger tasir.
   *
   * Kor Siparis Modundaki aliciya URETILMEZ ve iceren satir dusurulur. Kiraci
   * bu degiskeni kullanmakta serbesttir; kisit gonderim aninda uygulanir.
   */
  financial: boolean;
  /** Onizleme ve duzenleme ekraninda gosterilen ornek deger. */
  example: string;
}

/** Her konuda bulunan degiskenler. */
const ORTAK_DEGISKENLER: readonly TemplateVariable[] = [
  { key: 'alici', label: 'Alıcının adı', financial: false, example: 'Ayşe Yılmaz' },
  {
    key: 'portalAdresi',
    label: 'Portal adresi',
    financial: false,
    example: 'https://portal.example.com',
  },
];

export const TEMPLATE_VARIABLES: Record<NotificationTopic, readonly TemplateVariable[]> = {
  [NotificationTopic.ORDER_STATUS]: [
    ...ORTAK_DEGISKENLER,
    { key: 'siparisNo', label: 'Sipariş numarası', financial: false, example: 'SP-2026-000418' },
    { key: 'durum', label: 'Yeni durum', financial: false, example: 'Onaylandı' },
    { key: 'isletme', label: 'İşletme ünvanı', financial: false, example: 'Marmara Otelcilik A.Ş.' },
    { key: 'tutar', label: 'Sipariş tutarı', financial: true, example: '12.480,00 TL' },
    {
      key: 'aciklama',
      label: 'İptal/ret gerekçesi (yoksa satır düşer)',
      financial: false,
      example: 'Stok yetersizliği',
    },
    {
      key: 'siparisBaglantisi',
      label: 'Siparişler ekranının bağlantısı',
      financial: false,
      example: 'https://portal.example.com/panel/siparisler',
    },
  ],

  [NotificationTopic.ORDER_APPROVAL_PENDING]: [
    ...ORTAK_DEGISKENLER,
    { key: 'siparisNo', label: 'Sipariş numarası', financial: false, example: 'SP-2026-000419' },
    { key: 'gonderen', label: 'Siparişi gönderen kişi', financial: false, example: 'Mehmet Barista' },
    { key: 'kalemSayisi', label: 'Kalem sayısı', financial: false, example: '7' },
    { key: 'tutar', label: 'Sipariş tutarı', financial: true, example: '3.240,50 TL' },
    {
      key: 'onayBaglantisi',
      label: 'Onay ekranının bağlantısı',
      financial: false,
      example: 'https://portal.example.com/panel/onaylar',
    },
  ],

  [NotificationTopic.PAYMENT_RECEIVED]: [
    ...ORTAK_DEGISKENLER,
    { key: 'tutar', label: 'Tahsilat tutarı', financial: true, example: '5.000,00 TL' },
    { key: 'yontem', label: 'Tahsilat yöntemi', financial: false, example: 'Kredi kartı' },
    { key: 'isletme', label: 'İşletme ünvanı', financial: false, example: 'Marmara Otelcilik A.Ş.' },
    {
      key: 'belgeNo',
      label: 'Kapatılan belge (yoksa satır düşer)',
      financial: false,
      example: 'FT-2026-004120',
    },
    {
      key: 'ekstreBaglantisi',
      label: 'Ekstre ekranının bağlantısı',
      financial: false,
      example: 'https://portal.example.com/panel/ekstre',
    },
  ],

  [NotificationTopic.DUE_DATE_REMINDER]: [
    ...ORTAK_DEGISKENLER,
    { key: 'belgeNo', label: 'Belge numarası', financial: false, example: 'FT-2026-004120' },
    { key: 'vadeTarihi', label: 'Vade tarihi', financial: false, example: '20.07.2026' },
    {
      key: 'vadeDurumu',
      label: 'Vade durumu ("geçen" / "yaklaşan")',
      financial: false,
      example: 'geçen',
    },
    {
      key: 'vadeCumlesi',
      label: 'Vade cümlesi — gecikme gününü içerir',
      financial: false,
      example: 'FT-2026-004120 numaralı belgenin vadesi 20.07.2026 tarihinde doldu (12 gün).',
    },
    { key: 'tutar', label: 'Belge tutarı', financial: true, example: '8.750,25 TL' },
    {
      key: 'odemeBaglantisi',
      label: 'Ödeme ekranının bağlantısı',
      financial: false,
      example: 'https://portal.example.com/panel/odeme',
    },
  ],

  [NotificationTopic.SECURITY]: [
    ...ORTAK_DEGISKENLER,
    { key: 'olay', label: 'Güvenlik olayı', financial: false, example: 'Yeni cihazdan giriş' },
    { key: 'zaman', label: 'Olay zamanı', financial: false, example: '28.07.2026' },
    {
      key: 'konum',
      label: 'Şehir ve IP (yoksa satır düşer)',
      financial: false,
      example: 'İstanbul · 203.0.113.10',
    },
    {
      key: 'guvenlikBaglantisi',
      label: 'Güvenlik ekranının bağlantısı',
      financial: false,
      example: 'https://portal.example.com/panel/guvenlik',
    },
  ],

  [NotificationTopic.INTEGRATION_ALERT]: [
    ...ORTAK_DEGISKENLER,
    { key: 'kanal', label: 'Entegrasyon kanalı', financial: false, example: 'Stok' },
    {
      key: 'ayrinti',
      label: 'Durum açıklaması',
      financial: false,
      example: 'Köprüye 14 dakikadır ulaşılamıyor.',
    },
    {
      key: 'entegrasyonBaglantisi',
      label: 'Entegrasyon ekranının bağlantısı',
      financial: false,
      example: 'https://portal.example.com/panel/entegrasyon',
    },
  ],
};

/** Konunun parasal degiskenleri - kor modda uretilmeyecek olanlar. */
export function financialVariableKeys(topic: NotificationTopic): readonly string[] {
  return TEMPLATE_VARIABLES[topic].filter((degisken) => degisken.financial).map((d) => d.key);
}

/**
 * Kor Siparis Modundaki aliciya ULASABILEN konular.
 *
 * Tahsilat ve vade konulari `BALANCE_VIEW` yetkisi arandigi icin bu kullaniciya
 * zaten hic uretilmez (bkz. NotificationService.aliciUygunMu); tutarlarini konu
 * satirinda tasimalari sakincasizdir - "Tahsilatiniz islendi" cumlesi tutarsiz
 * zaten anlamsizdir.
 *
 * Asagidaki iki konu ise fiyat gormeyen aliciya da GIDER. Konu satirlarina
 * parasal degisken konmasi iki ayri sorun uretir: kilit ekraninda gorunur ve
 * kor moddaki alici icin degeri hic uretilmedigi icin konu varsayilana duser -
 * yani sablonu yazan kisi yazdigindan baska bir konu satiri gonderir.
 */
export const BLIND_REACHABLE_TOPICS: readonly NotificationTopic[] = [
  NotificationTopic.ORDER_STATUS,
  NotificationTopic.ORDER_APPROVAL_PENDING,
];

// ---------------------------------------------------------------------------
// Sablon metni
// ---------------------------------------------------------------------------

/** {{ad}} - bosluga izin verilir, ad harf ve rakamdan olusur. */
export const TEMPLATE_PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-zÇĞİÖŞÜçğıöşü0-9_]+)\s*\}\}/g;

/** Metinde gecen degisken adlari (tekrarsiz, gorulme sirasiyla). */
export function extractPlaceholders(text: string): string[] {
  const bulunanlar: string[] = [];

  for (const eslesme of text.matchAll(TEMPLATE_PLACEHOLDER_PATTERN)) {
    const ad = eslesme[1];
    if (ad && !bulunanlar.includes(ad)) bulunanlar.push(ad);
  }

  return bulunanlar;
}

/**
 * Sablondaki TANINMAYAN degisken adlari.
 *
 * Kaydetme aninda reddedilir. Yazim hatasi ("{{tutari}}") sessizce kabul
 * edilseydi, satir dusurme kurali yuzunden o satir HIC gorunmezdi; kullanici
 * eksigi ancak gercek bir bildirim gittikten sonra fark ederdi.
 */
export function unknownPlaceholders(topic: NotificationTopic, text: string): string[] {
  const tanimli = new Set(TEMPLATE_VARIABLES[topic].map((degisken) => degisken.key));
  return extractPlaceholders(text).filter((ad) => !tanimli.has(ad));
}

export const notificationTemplateBodySchema = z.string().trim().min(10).max(4000);
export const notificationTemplateSubjectSchema = z.string().trim().min(3).max(200);

export const upsertNotificationTemplateSchema = z
  .object({
    topic: z.nativeEnum(NotificationTopic),
    channel: z.nativeEnum(NotificationChannel),
    subjectTemplate: notificationTemplateSubjectSchema,
    bodyTemplate: notificationTemplateBodySchema,
  })
  .superRefine((deger, ctx) => {
    for (const alan of ['subjectTemplate', 'bodyTemplate'] as const) {
      const bilinmeyen = unknownPlaceholders(deger.topic, deger[alan]);

      if (bilinmeyen.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [alan],
          message: `Tanınmayan değişken: ${bilinmeyen.map((ad) => `{{${ad}}}`).join(', ')}`,
        });
      }
    }

    /* Kor moddaki aliciya ulasabilen konularda konu satiri parasal deger
       TASIYAMAZ (bkz. BLIND_REACHABLE_TOPICS). Govdede tutar yazmak
       kiracinin karari - o satir gerektiginde dusurulur; konuda yazmak ise
       dusurulemez, konunun tamamini varsayilana geri dondurur. */
    if (BLIND_REACHABLE_TOPICS.includes(deger.topic)) {
      const parasal = new Set(financialVariableKeys(deger.topic));
      const konudaParasal = extractPlaceholders(deger.subjectTemplate).filter((ad) =>
        parasal.has(ad),
      );

      if (konudaParasal.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['subjectTemplate'],
          message:
            `Konu satırında parasal değer kullanılamaz (${konudaParasal
              .map((ad) => `{{${ad}}}`)
              .join(', ')}): bu bildirim fiyat görmeyen kullanıcıya da gider ve ` +
            'konu satırı kilit ekranında görünür.',
        });
      }
    }
  });

export type UpsertNotificationTemplateRequest = z.infer<typeof upsertNotificationTemplateSchema>;

// ---------------------------------------------------------------------------
// Ekran gorunumu
// ---------------------------------------------------------------------------

export const notificationTemplateSchema = z.object({
  topic: z.nativeEnum(NotificationTopic),
  topicLabel: z.string(),
  channel: z.nativeEnum(NotificationChannel),
  channelLabel: z.string(),
  /** Kodda duran metin - "varsayılana dön" bunu geri getirir. */
  defaultSubject: z.string(),
  defaultBody: z.string(),
  /** Kiracinin uzerine yazdigi metin. null ise varsayilan yururluktedir. */
  subjectTemplate: z.string().nullable(),
  bodyTemplate: z.string().nullable(),
  customized: z.boolean(),
  updatedAt: z.string().nullable(),
  updatedByName: z.string().nullable(),
  variables: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      financial: z.boolean(),
      example: z.string(),
    }),
  ),
});

export type NotificationTemplateView = z.infer<typeof notificationTemplateSchema>;

export const notificationTemplateListSchema = z.object({
  templates: z.array(notificationTemplateSchema),
});

export type NotificationTemplateList = z.infer<typeof notificationTemplateListSchema>;

/**
 * Onizleme talebi.
 *
 * Kaydedilmemis metin uzerinde calisir: sablonu once kaydedip sonra gormek,
 * hatali bir metnin yururlukte kaldigi bir aralik birakir.
 */
export const notificationTemplatePreviewSchema = z.object({
  topic: z.nativeEnum(NotificationTopic),
  channel: z.nativeEnum(NotificationChannel),
  subjectTemplate: notificationTemplateSubjectSchema,
  bodyTemplate: notificationTemplateBodySchema,
});

export type NotificationTemplatePreviewRequest = z.infer<typeof notificationTemplatePreviewSchema>;

/**
 * Onizleme yaniti IKI SURUM dondurur.
 *
 * Kor Siparis Modundaki bayinin ne alacagini gormeden sablon yazmak, tutarin
 * sizip sizmadigini gonderdikten sonra ogrenmek demektir. Ekran ikisini yan
 * yana gosterir; boylece kural bir aciklama metni degil, GORULEN bir sey olur.
 */
export const notificationTemplatePreviewResultSchema = z.object({
  standard: z.object({ subject: z.string(), body: z.string() }),
  blind: z.object({ subject: z.string(), body: z.string() }),
  /** Kor surumde dusurulen satir sayisi - "neden kısa" sorusunu cevaplar. */
  droppedLineCount: z.number().int(),
});

export type NotificationTemplatePreviewResult = z.infer<
  typeof notificationTemplatePreviewResultSchema
>;
