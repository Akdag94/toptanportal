/**
 * ToptanPortal - Logo ERP Kopru Sozlesmeleri
 *
 * Bu dosya IKI ayri sinirin sozlesmesini tasir:
 *
 *   1. Bulut API  <->  on-prem kopru  (mTLS tuneli, `bridge*` tipleri)
 *   2. Bulut API  <->  yonetim arayuzu  (entegrasyon durum ekrani)
 *
 * Ikisi ayni dosyada durur cunku ikisi de AYNI olayin farkli yuzudur: koprunun
 * sozunu tuttugu sey, ekranda gosterilen sey olmalidir. Ayri dosyalara boldugumuz
 * anda, ekranin "senkron tamam" dedigi ile koprunun gonderdigi birbirinden
 * bagimsiz evrilmeye baslar.
 *
 * YON KURALI: Kopru bulutu HIC CAGIRMAZ. Baglantiyi her zaman bulut baslatir;
 * sirket ici agda disaridan erisilebilen bir ucun bulunmamasi, musterinin
 * guvenlik ekibine verilen ilk sozdur. Kopru yalnizca yanit verir.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Kopru saglik durumu
// ---------------------------------------------------------------------------

export const BridgeStatus = {
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  UNREACHABLE: 'UNREACHABLE',
} as const;

export type BridgeStatus = (typeof BridgeStatus)[keyof typeof BridgeStatus];

export const BRIDGE_STATUS_LABELS: Record<BridgeStatus, string> = {
  HEALTHY: 'Çalışıyor',
  DEGRADED: 'Kısmi Çalışıyor',
  UNREACHABLE: 'Ulaşılamıyor',
};

/**
 * Koprunun kendi sagligi ile LOGO'nun sagligi ayri raporlanir. Kopru ayakta
 * ama Logo Object Service kapaliysa durum DEGRADED'dir: siparis kuyrukta
 * beklemelidir, olu (DEAD) isaretlenmemelidir. Tek bir "saglikli mi" bayragi
 * bu ayrimi yapamaz ve gecici bir Logo bakimi, siparisleri kaybettirir.
 */
export const bridgeHealthSchema = z.object({
  status: z.nativeEnum(BridgeStatus),
  /** Kopru surumu - protokol uyumsuzlugunu tanilamak icin. */
  version: z.string(),
  /** Logo Object Service erisilebilir mi. */
  logoServiceUp: z.boolean(),
  /** Logo veritabani (MSSQL) erisilebilir mi. */
  databaseUp: z.boolean(),
  /** Koprunun bagli oldugu Logo firma numarasi. */
  companyNumber: z.number().int(),
  /** Logo donem numarasi - yil sonu donem devrinde degisir. */
  periodNumber: z.number().int(),
  checkedAt: z.string(),
  message: z.string().nullable(),
});

export type BridgeHealth = z.infer<typeof bridgeHealthSchema>;

// ---------------------------------------------------------------------------
// Fark (delta) akislari
//
// Tum akislar imlecle ilerler. Imlec bir ZAMAN DAMGASI DEGIL, Logo tarafindaki
// degisiklik sirasi (LOGICALREF / timestamp bilesimi) uzerine kuruludur:
// sistem saatleri kayabilir, saat farki bir kaydi atlatir. Sira numarasi kaymaz.
// ---------------------------------------------------------------------------

export const stockDeltaItemSchema = z.object({
  /** Logo stok kodu - portaldeki `Product.logoCode` ile eslesir. */
  logoCode: z.string(),
  warehouseCode: z.string(),
  /** Logo'daki fiili stok. Portal bu degerden REZERVASYONLARI kendi duser. */
  onHand: z.number(),
  /** Logo tarafinda bekleyen sevk miktari. */
  allocated: z.number(),
  unitCode: z.string(),
  changedAt: z.string(),
});

export type StockDeltaItem = z.infer<typeof stockDeltaItemSchema>;

export const stockDeltaPageSchema = z.object({
  items: z.array(stockDeltaItemSchema),
  /** Bir sonraki istekte gonderilecek imlec. */
  nextCursor: z.string(),
  hasMore: z.boolean(),
});

export type StockDeltaPage = z.infer<typeof stockDeltaPageSchema>;

export const priceDeltaItemSchema = z.object({
  logoCode: z.string(),
  /** Logo fiyat kartı numarasi - portaldeki fiyat listesiyle eslesir. */
  priceListCode: z.string(),
  unitCode: z.string(),
  price: z.number(),
  currency: z.string(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  changedAt: z.string(),
});

export type PriceDeltaItem = z.infer<typeof priceDeltaItemSchema>;

export const priceDeltaPageSchema = z.object({
  items: z.array(priceDeltaItemSchema),
  nextCursor: z.string(),
  hasMore: z.boolean(),
});

export type PriceDeltaPage = z.infer<typeof priceDeltaPageSchema>;

export const accountDeltaItemSchema = z.object({
  /** Logo cari hesap kodu - portaldeki `Company.logoCode` ile eslesir. */
  logoCode: z.string(),
  documentNumber: z.string(),
  /** Logo fis turu: 1 satis faturasi, 3 iade, 31 tahsilat vb. */
  documentType: z.number().int(),
  entryDate: z.string(),
  dueDate: z.string().nullable(),
  debit: z.number(),
  credit: z.number(),
  description: z.string().nullable(),
  changedAt: z.string(),
});

export type AccountDeltaItem = z.infer<typeof accountDeltaItemSchema>;

export const accountDeltaPageSchema = z.object({
  items: z.array(accountDeltaItemSchema),
  nextCursor: z.string(),
  hasMore: z.boolean(),
});

export type AccountDeltaPage = z.infer<typeof accountDeltaPageSchema>;

// ---------------------------------------------------------------------------
// Siparis aktarimi
// ---------------------------------------------------------------------------

export const bridgeOrderLineSchema = z.object({
  logoCode: z.string(),
  unitCode: z.string(),
  quantity: z.number().positive(),
  unitPrice: z.number().nonnegative(),
  discountRate: z.number().min(0).max(100),
  vatRate: z.number().min(0).max(100),
  lineNote: z.string().nullable(),
});

export type BridgeOrderLine = z.infer<typeof bridgeOrderLineSchema>;

/**
 * `portalOrderId` islemin IDEMPOTENCY ANAHTARIDIR. Kopru ayni kimlikle ikinci
 * kez cagrildiginda yeni siparis ACMAZ, ilk sonucu doner. Ag zaman asimi
 * yuzunden tekrar denenen bir istek, Logo'da mukerrer siparis birakamaz -
 * mukerrer siparis, kaybolan siparisten pahalidir: sevk edilir ve fatura edilir.
 */
export const bridgeOrderPushSchema = z.object({
  portalOrderId: z.string().uuid(),
  orderNumber: z.string(),
  companyLogoCode: z.string(),
  warehouseCode: z.string(),
  orderDate: z.string(),
  deliveryDate: z.string().nullable(),
  currency: z.string(),
  customerNote: z.string().nullable(),
  lines: z.array(bridgeOrderLineSchema).min(1),
});

export type BridgeOrderPush = z.infer<typeof bridgeOrderPushSchema>;

export const bridgeOrderResultSchema = z.object({
  portalOrderId: z.string().uuid(),
  /** Logo tarafindaki siparis numarasi. */
  logoOrderNumber: z.string(),
  logoReference: z.number().int(),
  /** Kayit bu cagrida mi olustu, yoksa daha once mi vardi (idempotent tekrar). */
  created: z.boolean(),
  transferredAt: z.string(),
});

export type BridgeOrderResult = z.infer<typeof bridgeOrderResultSchema>;

/**
 * Koprunun REDDETME sebebi. Ag hatasindan ayrilir: ag hatasi tekrar denenir,
 * is kurali hatasi tekrar denendiginde ayni sonucu verir ve kuyrugu tikar.
 */
export const BridgeRejectionReason = {
  UNKNOWN_PRODUCT: 'UNKNOWN_PRODUCT',
  UNKNOWN_COMPANY: 'UNKNOWN_COMPANY',
  UNKNOWN_WAREHOUSE: 'UNKNOWN_WAREHOUSE',
  PERIOD_CLOSED: 'PERIOD_CLOSED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
} as const;

export type BridgeRejectionReason =
  (typeof BridgeRejectionReason)[keyof typeof BridgeRejectionReason];

export const BRIDGE_REJECTION_LABELS: Record<BridgeRejectionReason, string> = {
  UNKNOWN_PRODUCT: 'Logo’da bulunmayan stok kartı',
  UNKNOWN_COMPANY: 'Logo’da bulunmayan cari hesap',
  UNKNOWN_WAREHOUSE: 'Logo’da bulunmayan ambar',
  PERIOD_CLOSED: 'Logo dönemi kapalı',
  VALIDATION_FAILED: 'Logo doğrulaması başarısız',
};

export const bridgeErrorSchema = z.object({
  reason: z.nativeEnum(BridgeRejectionReason),
  message: z.string(),
  /** Sorunlu satirin stok kodu - operatorun duzeltecegi yeri gosterir. */
  offendingCode: z.string().nullable(),
});

export type BridgeError = z.infer<typeof bridgeErrorSchema>;

// ---------------------------------------------------------------------------
// Yonetim arayuzu gorunumleri
// ---------------------------------------------------------------------------

export const SyncChannel = {
  STOCK: 'STOCK',
  PRICE: 'PRICE',
  ACCOUNT: 'ACCOUNT',
  ORDER: 'ORDER',
} as const;

export type SyncChannel = (typeof SyncChannel)[keyof typeof SyncChannel];

export const SYNC_CHANNEL_LABELS: Record<SyncChannel, string> = {
  STOCK: 'Stok',
  PRICE: 'Fiyat',
  ACCOUNT: 'Cari Hareket',
  ORDER: 'Sipariş Aktarımı',
};

export const syncChannelStateSchema = z.object({
  channel: z.nativeEnum(SyncChannel),
  channelLabel: z.string(),
  enabled: z.boolean(),
  lastSuccessAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  lastError: z.string().nullable(),
  /** Son turda islenen kayit sayisi - "calisiyor ama bos donuyor" ayrimi icin. */
  lastItemCount: z.number().int(),
  /** Ardisik hata sayisi; sifirlanmasi ilk basarili turda olur. */
  consecutiveFailures: z.number().int(),
});

export type SyncChannelState = z.infer<typeof syncChannelStateSchema>;

export const integrationStatusSchema = z.object({
  bridgeConfigured: z.boolean(),
  health: bridgeHealthSchema.nullable(),
  channels: z.array(syncChannelStateSchema),
  /** Logo'ya gonderilmeyi bekleyen olay sayisi. */
  pendingEvents: z.number().int(),
  /** Azami deneme sayisi asilmis, ELLE mudahale bekleyen olaylar. */
  deadEvents: z.number().int(),
  /** En eski bekleyen olayin yasi (saniye) - gecikmenin tek gercek olcusu. */
  oldestPendingSeconds: z.number().int().nullable(),
});

export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;

export const deadEventViewSchema = z.object({
  id: z.string(),
  eventType: z.string(),
  aggregateId: z.string(),
  /** Siparis numarasi gibi insan tarafindan taninabilir bir etiket. */
  label: z.string().nullable(),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
});

export type DeadEventView = z.infer<typeof deadEventViewSchema>;

export const retryEventSchema = z.object({
  /** Bos birakilirsa TUM olu olaylar yeniden kuyruga alinir. */
  eventIds: z.array(z.string()).max(200).optional(),
});

export type RetryEventRequest = z.infer<typeof retryEventSchema>;

export const triggerSyncSchema = z.object({
  channel: z.nativeEnum(SyncChannel),
  /**
   * Imleci sifirlayarak TAM senkron. Pahalidir ve yalnizca veri tutarsizligi
   * suphesinde kullanilir; varsayilan olarak kaldigi yerden devam edilir.
   */
  fullResync: z.boolean().default(false),
});

export type TriggerSyncRequest = z.infer<typeof triggerSyncSchema>;

export const syncRunResultSchema = z.object({
  channel: z.nativeEnum(SyncChannel),
  itemCount: z.number().int(),
  durationMs: z.number().int(),
  hasMore: z.boolean(),
  cursor: z.string().nullable(),
});

export type SyncRunResult = z.infer<typeof syncRunResultSchema>;
