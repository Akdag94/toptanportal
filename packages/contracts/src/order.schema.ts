/**
 * ToptanPortal - Sepet ve Siparis Sozlesmeleri
 */

import { z } from 'zod';
import { StockStatus } from './blind-order';

// ---------------------------------------------------------------------------
// Sepet
// ---------------------------------------------------------------------------

export const cartItemInputSchema = z.object({
  productId: z.string().uuid(),
  unitId: z.string().uuid(),
  quantity: z
    .number()
    .positive('Miktar sıfırdan büyük olmalıdır.')
    .max(999999, 'Miktar çok yüksek.'),
  note: z.string().trim().max(240).optional(),
});

export type CartItemInput = z.infer<typeof cartItemInputSchema>;

export const setCartItemsSchema = z.object({
  /** Sepetin tamamını değiştirir. Çevrimdışı depo modunun senkronizasyonu bunu kullanır. */
  items: z.array(cartItemInputSchema).max(500, 'Sepette en fazla 500 satır olabilir.'),
  note: z.string().trim().max(500).optional(),
});

export type SetCartItemsRequest = z.infer<typeof setCartItemsSchema>;

/** Satır miktarını mutlak değere ayarlar. Sıfır göndermek satırı siler. */
export const setCartItemQuantitySchema = z.object({
  quantity: z.number().min(0, 'Miktar negatif olamaz.').max(999999, 'Miktar çok yüksek.'),
});

export type SetCartItemQuantityRequest = z.infer<typeof setCartItemQuantitySchema>;

export const cartLineSchema = z.object({
  productId: z.string().uuid(),
  productCode: z.string(),
  productName: z.string(),
  imageUrl: z.string().nullable(),
  unitId: z.string().uuid(),
  unitCode: z.string(),
  unitName: z.string(),
  quantity: z.number(),
  conversionFactor: z.number(),
  baseQuantity: z.number(),
  stockStatus: z.nativeEnum(StockStatus),
  /** Talep edilen miktar serbest stoğu aşıyorsa true. */
  exceedsStock: z.boolean(),
  note: z.string().nullable(),

  // --- Aşağıdakiler yalnızca fiyat görme yetkisi olan kullanıcıya gönderilir ---
  unitPrice: z.number().optional(),
  grossAmount: z.number().optional(),
  discountTotal: z.number().optional(),
  netAmount: z.number().optional(),
  vatRate: z.number().optional(),
  vatAmount: z.number().optional(),
  lineTotal: z.number().optional(),
  appliedDiscounts: z
    .array(
      z.object({
        kind: z.enum(['LINE_VOLUME', 'FOOTER_CHAIN']),
        ratePercent: z.number(),
        amount: z.number(),
        chainOrder: z.number(),
        logoDiscountCode: z.string().nullable(),
      }),
    )
    .optional(),
});

export type CartLine = z.infer<typeof cartLineSchema>;

export const cartViewSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  lines: z.array(cartLineSchema),
  lineCount: z.number().int(),
  note: z.string().nullable(),
  blindOrderMode: z.boolean(),
  /** Stok yetersizliği olan satır var mı — sipariş butonunu kilitler. */
  hasStockIssue: z.boolean(),

  // --- Toplamlar: fiyat yetkisi yoksa gönderilmez ---
  grossTotal: z.number().optional(),
  discountTotal: z.number().optional(),
  netTotal: z.number().optional(),
  vatTotal: z.number().optional(),
  grandTotal: z.number().optional(),
  currency: z.string().optional(),
  priceListName: z.string().nullable().optional(),
});

export type CartView = z.infer<typeof cartViewSchema>;

// ---------------------------------------------------------------------------
// Siparis
// ---------------------------------------------------------------------------

export const OrderStatus = {
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  QUEUED: 'QUEUED',
  SENDING: 'SENDING',
  CONFIRMED: 'CONFIRMED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  PENDING_APPROVAL: 'Onay Bekliyor',
  QUEUED: 'Sıraya Alındı',
  SENDING: 'İletiliyor',
  CONFIRMED: 'Onaylandı',
  REJECTED: 'Reddedildi',
  CANCELLED: 'İptal Edildi',
  FAILED: 'İletilemedi',
};

export const placeOrderSchema = z.object({
  /** Sevk edilecek ambar. Boş bırakılırsa işletmenin varsayılan ambarı kullanılır. */
  warehouseId: z.string().uuid().optional(),
  customerNote: z.string().trim().max(500).optional(),
  requestedDeliveryDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Tarih YYYY-AA-GG biçiminde olmalıdır.')
    .optional(),
});

export type PlaceOrderRequest = z.infer<typeof placeOrderSchema>;

export const orderLineViewSchema = z.object({
  lineNumber: z.number().int(),
  productId: z.string().uuid(),
  productCode: z.string(),
  productName: z.string(),
  unitCode: z.string(),
  quantity: z.number(),
  baseQuantity: z.number(),
  note: z.string().nullable(),

  unitPrice: z.number().optional(),
  grossAmount: z.number().optional(),
  discountTotal: z.number().optional(),
  netAmount: z.number().optional(),
  vatRate: z.number().optional(),
  vatAmount: z.number().optional(),
  lineTotal: z.number().optional(),
});

export type OrderLineView = z.infer<typeof orderLineViewSchema>;

export const orderViewSchema = z.object({
  id: z.string().uuid(),
  orderNumber: z.string(),
  status: z.nativeEnum(OrderStatus),
  statusLabel: z.string(),
  channel: z.enum(['WEB', 'IOS', 'SALES_REP', 'BULK_IMPORT', 'TEMPLATE']),
  companyId: z.string().uuid(),
  companyTitle: z.string(),
  warehouseName: z.string(),
  createdByName: z.string(),
  approvedByName: z.string().nullable(),
  lines: z.array(orderLineViewSchema),
  customerNote: z.string().nullable(),
  rejectReason: z.string().nullable(),
  logoOrderNumber: z.string().nullable(),
  submittedAt: z.string(),
  approvedAt: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  requestedDeliveryDate: z.string().nullable(),
  blindOrderMode: z.boolean(),

  grossTotal: z.number().optional(),
  discountTotal: z.number().optional(),
  netTotal: z.number().optional(),
  vatTotal: z.number().optional(),
  grandTotal: z.number().optional(),
  currency: z.string().optional(),
});

export type OrderView = z.infer<typeof orderViewSchema>;

/** Sipariş oluşturma sonucu — onaya düşen sipariş de başarılı sayılır. */
export const placeOrderResultSchema = z.object({
  order: orderViewSchema,
  /** true ise sipariş Logo'ya gitmedi, işletme yetkilisinin onayını bekliyor. */
  requiresApproval: z.boolean(),
  message: z.string(),
});

export type PlaceOrderResult = z.infer<typeof placeOrderResultSchema>;

export const rejectOrderSchema = z.object({
  reason: z.string().trim().min(3, 'Gerekçe zorunludur.').max(500),
});

export type RejectOrderRequest = z.infer<typeof rejectOrderSchema>;

export const orderListQuerySchema = z.object({
  status: z.nativeEnum(OrderStatus).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type OrderListQuery = z.infer<typeof orderListQuerySchema>;

// ---------------------------------------------------------------------------
// Stok yetersizligi ayrintisi
// ---------------------------------------------------------------------------

/**
 * STOCK_INSUFFICIENT hatasinin `details` alaninda doner.
 * Kor Siparis Modunda `available` GONDERILMEZ; yalnizca hangi urunun
 * yetmedigi bildirilir.
 */
export const stockShortageSchema = z.object({
  productId: z.string().uuid(),
  productName: z.string(),
  unitCode: z.string(),
  requested: z.number(),
  available: z.number().optional(),
});

export type StockShortage = z.infer<typeof stockShortageSchema>;

// ---------------------------------------------------------------------------
// Rutin siparis sablonlari
// ---------------------------------------------------------------------------

export const orderTemplateItemInputSchema = z.object({
  productId: z.string().uuid(),
  unitId: z.string().uuid(),
  quantity: z.number().positive().max(999999),
});

export const upsertOrderTemplateSchema = z.object({
  name: z.string().trim().min(2, 'Şablon adı en az 2 karakter olmalıdır.').max(120),
  isShared: z.boolean().default(false),
  items: z
    .array(orderTemplateItemInputSchema)
    .min(1, 'Şablonda en az bir ürün olmalıdır.')
    .max(300, 'Şablonda en fazla 300 ürün olabilir.'),
});

export type UpsertOrderTemplateRequest = z.infer<typeof upsertOrderTemplateSchema>;

/** Mevcut sepeti şablona dönüştürür — "bu siparişi her hafta tekrarla". */
export const createTemplateFromCartSchema = z.object({
  name: z.string().trim().min(2, 'Şablon adı en az 2 karakter olmalıdır.').max(120),
  isShared: z.boolean().default(false),
});

export type CreateTemplateFromCartRequest = z.infer<typeof createTemplateFromCartSchema>;

export const orderTemplateViewSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  isShared: z.boolean(),
  ownerName: z.string(),
  itemCount: z.number().int(),
  useCount: z.number().int(),
  lastUsedAt: z.string().nullable(),
  items: z.array(
    z.object({
      productId: z.string().uuid(),
      productName: z.string(),
      productCode: z.string(),
      imageUrl: z.string().nullable(),
      unitId: z.string().uuid(),
      unitCode: z.string(),
      quantity: z.number(),
      stockStatus: z.nativeEnum(StockStatus),
    }),
  ),
});

export type OrderTemplateView = z.infer<typeof orderTemplateViewSchema>;

/** Şablonu sepete uygularken stokta olmayan satırlar atlanır ve raporlanır. */
export const applyTemplateResultSchema = z.object({
  cart: cartViewSchema,
  addedCount: z.number().int(),
  skipped: z.array(
    z.object({
      productName: z.string(),
      reason: z.enum(['OUT_OF_STOCK', 'UNAVAILABLE', 'UNIT_CHANGED']),
    }),
  ),
});

export type ApplyTemplateResult = z.infer<typeof applyTemplateResultSchema>;

// ---------------------------------------------------------------------------
// Toplu siparis ice aktarimi
// ---------------------------------------------------------------------------

/**
 * Excel'den kopyalanmis metin. Dosya yukleme yerine METIN gonderilir: tarayici
 * CSV'yi zaten metin olarak okuyabilir ve coklu parcali (multipart) yukleme,
 * arayuze de sunucuya da gereksiz bir katman ekler.
 */
export const bulkImportSchema = z.object({
  content: z.string().min(1).max(200_000),
  /** true ise mevcut sepet TEMIZLENIR; false ise uzerine eklenir. */
  replaceExisting: z.boolean().default(false),
});

export type BulkImportRequest = z.infer<typeof bulkImportSchema>;

export const bulkImportResultSchema = z.object({
  cart: cartViewSchema,
  importedCount: z.number().int(),
  totalLines: z.number().int(),
  /** Portalde bulunamayan stok kodlari - satir numarasiyla birlikte. */
  unmatchedCodes: z.array(z.string()),
  /** Okunamayan satirlar. */
  invalidLines: z.array(z.string()),
});

export type BulkImportResult = z.infer<typeof bulkImportResultSchema>;
