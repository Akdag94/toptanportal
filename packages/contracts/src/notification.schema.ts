/**
 * ToptanPortal - Bildirim Sozlesmeleri
 *
 * Bildirim teknik bir ayrinti degil, TICARI BIR SOZDUR: "siparisiniz onaylandi"
 * mesaji gitmezse bayi telefona sarilir ve portalin cozdugu is yeniden
 * operatorun masasina doner. Bu yuzden bildirim, gonderilip gonderilmedigi
 * SORULABILIR bir kayittir - gonder-ve-unut bir yan etki degil.
 *
 * IKI TUR ILETI VARDIR ve ayrimi hukukidir:
 *
 *  * ISLEMSEL ileti (siparis durumu, tahsilat, guvenlik): kullanicinin kendi
 *    baslattigi bir islemin sonucudur, ticari elektronik ileti SAYILMAZ ve
 *    Iletisim Yonetim Sistemi (IYS) izni gerektirmez.
 *  * TICARI ileti (kampanya, yeni urun duyurusu): 6563 sayili kanun geregi IYS
 *    izni ister. Bu modul ticari ileti GONDERMEZ; izin altyapisi
 *    (`ConsentRecord`) hazir olsa da kampanya kanali ayri bir istir ve iki
 *    turu ayni borudan gecirmek, izinsiz gonderimi bir yapilandirma hatasi
 *    kadar yakin hale getirir.
 *
 * KOR SIPARIS MODU BURADA DA GECERLIDIR. Fiyat gormeyen bir kullaniciya
 * "12.480,00 TL tutarindaki siparisiniz onaylandi" yazan bir e-posta gitmesi,
 * arayuzde ozenle gizlenen bilgiyi posta kutusundan sizdirir. Konu ve govde
 * bu yuzden ALICININ ROLUNE gore uretilir.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Kanallar ve konular
// ---------------------------------------------------------------------------

export const NotificationChannel = {
  EMAIL: 'EMAIL',
  /** iOS uygulamasi. Cihaz jetonu yoksa sessizce atlanir - hata degildir. */
  PUSH: 'PUSH',
} as const;

export type NotificationChannel = (typeof NotificationChannel)[keyof typeof NotificationChannel];

export const NotificationTopic = {
  /** Siparis onaylandi / reddedildi / iptal edildi. */
  ORDER_STATUS: 'ORDER_STATUS',
  /** Alt yetkilinin siparisi ana yetkilinin onayini bekliyor. */
  ORDER_APPROVAL_PENDING: 'ORDER_APPROVAL_PENDING',
  /** Tahsilat islendi. */
  PAYMENT_RECEIVED: 'PAYMENT_RECEIVED',
  /** Vadesi yaklasan veya gecen belge. */
  DUE_DATE_REMINDER: 'DUE_DATE_REMINDER',
  /** Sifre degisikligi, yeni cihazdan giris, hesap askiya alinmasi. */
  SECURITY: 'SECURITY',
  /** Kopru koptu, olu olay birikti - yalnizca yetkili yoneticilere. */
  INTEGRATION_ALERT: 'INTEGRATION_ALERT',
} as const;

export type NotificationTopic = (typeof NotificationTopic)[keyof typeof NotificationTopic];

/**
 * KAPATILAMAYAN konular.
 *
 * Guvenlik bildirimi bir hizmet degil, bir SAVUNMADIR: hesabi ele gecirilen
 * kullanicinin bunu ogrenmesinin tek yolu odur ve saldirganin ilk isi
 * bildirimi kapatmak olurdu. Ayni sekilde onay bekleyen siparis, ana yetkili
 * haberdar olmazsa depoda beklemeye devam eder - kapatilabilir olmasi
 * kullaniciya degil, siparisi bekleyen bayiye zarar verir.
 */
export const MANDATORY_TOPICS: readonly NotificationTopic[] = [
  NotificationTopic.SECURITY,
  NotificationTopic.ORDER_APPROVAL_PENDING,
];

export function isTopicMandatory(topic: NotificationTopic): boolean {
  return MANDATORY_TOPICS.includes(topic);
}

/**
 * Parasal deger TASIYAN konular.
 *
 * Kor Siparis Modundaki kullaniciya bu konularin tutarsiz surumu gonderilir;
 * gonderimi tamamen kesmek yanlis olurdu - siparisinin onaylandigini bilmek
 * fiyati gormekten bagimsiz bir ihtiyactir.
 */
export const FINANCIAL_TOPICS: readonly NotificationTopic[] = [
  NotificationTopic.ORDER_STATUS,
  NotificationTopic.ORDER_APPROVAL_PENDING,
  NotificationTopic.PAYMENT_RECEIVED,
  NotificationTopic.DUE_DATE_REMINDER,
];

export const TOPIC_LABELS: Record<NotificationTopic, string> = {
  [NotificationTopic.ORDER_STATUS]: 'Sipariş durumu',
  [NotificationTopic.ORDER_APPROVAL_PENDING]: 'Onay bekleyen sipariş',
  [NotificationTopic.PAYMENT_RECEIVED]: 'Tahsilat bildirimi',
  [NotificationTopic.DUE_DATE_REMINDER]: 'Vade hatırlatması',
  [NotificationTopic.SECURITY]: 'Hesap güvenliği',
  [NotificationTopic.INTEGRATION_ALERT]: 'Entegrasyon uyarısı',
};

export const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  [NotificationChannel.EMAIL]: 'E-posta',
  [NotificationChannel.PUSH]: 'Mobil bildirim',
};

// ---------------------------------------------------------------------------
// Gonderim kaydi
// ---------------------------------------------------------------------------

export const NotificationStatus = {
  PENDING: 'PENDING',
  SENT: 'SENT',
  /** Deneme hakki tukendi. Silinmez: gonderilemeyen bildirim de bir bilgidir. */
  FAILED: 'FAILED',
  /** Alici tercihine, rolune veya eksik adrese takildi. Hata degildir. */
  SUPPRESSED: 'SUPPRESSED',
} as const;

export type NotificationStatus = (typeof NotificationStatus)[keyof typeof NotificationStatus];

export const STATUS_LABELS: Record<NotificationStatus, string> = {
  [NotificationStatus.PENDING]: 'Kuyrukta',
  [NotificationStatus.SENT]: 'Gönderildi',
  [NotificationStatus.FAILED]: 'Gönderilemedi',
  [NotificationStatus.SUPPRESSED]: 'Gönderilmedi',
};

export const notificationMessageSchema = z.object({
  id: z.string(),
  topic: z.nativeEnum(NotificationTopic),
  channel: z.nativeEnum(NotificationChannel),
  status: z.nativeEnum(NotificationStatus),
  /** Kuyruga yazilirken DONDURULAN alici adresi. */
  recipient: z.string(),
  recipientUserId: z.string().uuid().nullable(),
  recipientName: z.string().nullable(),
  subject: z.string(),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  /** Gonderilmediyse sebebi ("tercih kapali", "adres yok"). */
  suppressedReason: z.string().nullable(),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
});

export type NotificationMessage = z.infer<typeof notificationMessageSchema>;

export const notificationQuerySchema = z.object({
  topic: z.nativeEnum(NotificationTopic).optional(),
  channel: z.nativeEnum(NotificationChannel).optional(),
  status: z.nativeEnum(NotificationStatus).optional(),
  recipientUserId: z.string().uuid().optional(),
  q: z.string().trim().max(120).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type NotificationQuery = z.infer<typeof notificationQuerySchema>;

export const notificationPageSchema = z.object({
  messages: z.array(notificationMessageSchema),
  totalCount: z.number().int(),
  hasMore: z.boolean(),
  /** Kuyrukta bekleyen ve gonderilemeyen sayilari - ekranin ust seridi. */
  pendingCount: z.number().int(),
  failedCount: z.number().int(),
});

export type NotificationPage = z.infer<typeof notificationPageSchema>;

// ---------------------------------------------------------------------------
// Tercihler
// ---------------------------------------------------------------------------

export const notificationPreferenceSchema = z.object({
  topic: z.nativeEnum(NotificationTopic),
  channel: z.nativeEnum(NotificationChannel),
  enabled: z.boolean(),
  /** true ise kullanici bu satiri degistiremez (bkz. MANDATORY_TOPICS). */
  locked: z.boolean(),
});

export type NotificationPreference = z.infer<typeof notificationPreferenceSchema>;

export const notificationPreferencesSchema = z.object({
  preferences: z.array(notificationPreferenceSchema),
  email: z.string(),
  /** Mobil cihaz kaydi yoksa PUSH satirlari acilsa da gonderim olmaz. */
  hasPushDevice: z.boolean(),
});

export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const updatePreferenceSchema = z.object({
  topic: z.nativeEnum(NotificationTopic),
  channel: z.nativeEnum(NotificationChannel),
  enabled: z.boolean(),
});

export type UpdatePreferenceRequest = z.infer<typeof updatePreferenceSchema>;

export const updatePreferencesSchema = z.object({
  updates: z.array(updatePreferenceSchema).min(1).max(40),
});

export type UpdatePreferencesRequest = z.infer<typeof updatePreferencesSchema>;

// ---------------------------------------------------------------------------
// Mobil cihaz kaydi
// ---------------------------------------------------------------------------

export const registerPushDeviceSchema = z.object({
  token: z.string().trim().min(20).max(255),
  /** WEB kabul edilmez: tarayici bildirimi ayri bir izin akisidir. */
  platform: z.enum(['IOS', 'ANDROID']),
  deviceName: z.string().trim().max(80).optional(),
});

export type RegisterPushDeviceRequest = z.infer<typeof registerPushDeviceSchema>;

// ---------------------------------------------------------------------------
// Sessiz saatler
// ---------------------------------------------------------------------------

/**
 * ZAMANLANMIS bildirimlerin (vade hatirlatmasi) gonderilebilecegi yerel saat
 * araligi. Islemsel bildirimler bu araligi TANIMAZ: siparisini gece 02:00'de
 * onaylatan bayi cevabi o anda bekler.
 *
 * Vade hatirlatmasi ise portalin kendi takviminden dogar; kullanicinin
 * telefonunu gece caldirmak icin hicbir sebep yoktur ve bir kez rahatsizlik
 * veren kanal, gerektiginde de kapatilmis olur.
 */
export const QUIET_HOURS = { startHour: 9, endHour: 20 } as const;

export function isWithinQuietHours(date: Date, timeZoneOffsetMinutes = 180): boolean {
  const local = new Date(date.getTime() + timeZoneOffsetMinutes * 60 * 1000);
  const hour = local.getUTCHours();
  return hour >= QUIET_HOURS.startHour && hour < QUIET_HOURS.endHour;
}
