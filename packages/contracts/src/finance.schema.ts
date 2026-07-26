/**
 * ToptanPortal - Cari Hesap, Ekstre ve Tahsilat Sozlesmeleri
 *
 * Bu dosyadaki hicbir gorunum Kor Siparis Modundaki kullaniciya ULASMAZ:
 * ilgili uc noktalar BALANCE_VIEW / STATEMENT_VIEW / AGING_REPORT_VIEW
 * yetkilerini ister, alt yetkilinin rol matrisinde bu yetkiler yoktur.
 * Suzgec (BlindOrderInterceptor) burada son savunma hattidir, birinci degil.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Cari hareket
// ---------------------------------------------------------------------------

export const AccountEntryKind = {
  OPENING: 'OPENING',
  INVOICE: 'INVOICE',
  RETURN: 'RETURN',
  PAYMENT: 'PAYMENT',
  CREDIT_NOTE: 'CREDIT_NOTE',
  DEBIT_NOTE: 'DEBIT_NOTE',
} as const;

export type AccountEntryKind = (typeof AccountEntryKind)[keyof typeof AccountEntryKind];

export const ACCOUNT_ENTRY_KIND_LABELS: Record<AccountEntryKind, string> = {
  OPENING: 'Devir',
  INVOICE: 'Satış Faturası',
  RETURN: 'İade Faturası',
  PAYMENT: 'Tahsilat',
  CREDIT_NOTE: 'Alacak Dekontu',
  DEBIT_NOTE: 'Borç Dekontu',
};

export const accountEntrySchema = z.object({
  id: z.string().uuid(),
  kind: z.nativeEnum(AccountEntryKind),
  kindLabel: z.string(),
  entryDate: z.string(),
  dueDate: z.string().nullable(),
  documentNumber: z.string(),
  description: z.string().nullable(),
  debit: z.number(),
  credit: z.number(),
  /** Belgenin kapanmamış kısmı. Alacak hareketlerinde daima 0'dır. */
  openAmount: z.number(),
  /** Satır bazında yürüyen bakiye — sunucuda hesaplanır, istemci toplamaz. */
  runningBalance: z.number(),
  currency: z.string(),
  /** Vadesi geçmiş gün sayısı. Kapanmış veya vadesi gelmemiş belgede 0. */
  overdueDays: z.number().int(),
  orderId: z.string().uuid().nullable(),
});

export type AccountEntry = z.infer<typeof accountEntrySchema>;

/**
 * Ekstre sorgusu. Tarih araligi verilmezse son 90 gun kullanilir.
 * Sayfalama imleci degil ofset kullanir: ekstre yuruyen bakiye tasidigi icin
 * satirlarin donem basindan itibaren sirali okunmasi gerekir.
 */
export const statementQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Tarih YYYY-AA-GG biçiminde olmalıdır.').optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Tarih YYYY-AA-GG biçiminde olmalıdır.').optional(),
  kind: z.nativeEnum(AccountEntryKind).optional(),
  /** Yalnızca kapanmamış belgeler. */
  onlyOpen: z.coerce.boolean().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type StatementQuery = z.infer<typeof statementQuerySchema>;

export const statementPageSchema = z.object({
  companyId: z.string().uuid(),
  companyTitle: z.string(),
  from: z.string(),
  to: z.string(),
  /** Dönem başı devir — ilk satırın yürüyen bakiyesi buradan başlar. */
  openingBalance: z.number(),
  closingBalance: z.number(),
  debitTotal: z.number(),
  creditTotal: z.number(),
  currency: z.string(),
  entries: z.array(accountEntrySchema),
  totalCount: z.number().int(),
  hasMore: z.boolean(),
});

export type StatementPage = z.infer<typeof statementPageSchema>;

// ---------------------------------------------------------------------------
// Bakiye ve risk ozeti
// ---------------------------------------------------------------------------

export const accountSummarySchema = z.object({
  companyId: z.string().uuid(),
  companyTitle: z.string(),
  currency: z.string(),
  /** Pozitif değer borcu, negatif değer alacağı gösterir. */
  balance: z.number(),
  overdueAmount: z.number(),
  overdueDays: z.number().int(),
  creditLimit: z.number(),
  /** Kalan açık hesap kapasitesi. Limit tanımsızsa null. */
  availableCredit: z.number().nullable(),
  paymentTermDays: z.number().int(),
  isBlocked: z.boolean(),
  blockReason: z.string().nullable(),
  /** Bu anda sipariş verilebilir mi — risk kalkanının tek cevabı. */
  canOrder: z.boolean(),
  openInvoiceCount: z.number().int(),
  lastPaymentAt: z.string().nullable(),
  lastPaymentAmount: z.number().nullable(),
  calculatedAt: z.string(),
});

export type AccountSummary = z.infer<typeof accountSummarySchema>;

// ---------------------------------------------------------------------------
// Yaslandirma (aging)
// ---------------------------------------------------------------------------

/**
 * Kova sinirlari sabittir; muhasebe raporlamasinda karsilastirilabilirlik
 * icin kiraci bazinda degistirilemez.
 */
export const AGING_BUCKETS = [
  { key: 'NOT_DUE', label: 'Vadesi Gelmemiş', minDays: null, maxDays: 0 },
  { key: 'DAYS_1_30', label: '1-30 Gün', minDays: 1, maxDays: 30 },
  { key: 'DAYS_31_60', label: '31-60 Gün', minDays: 31, maxDays: 60 },
  { key: 'DAYS_61_90', label: '61-90 Gün', minDays: 61, maxDays: 90 },
  { key: 'DAYS_90_PLUS', label: '90+ Gün', minDays: 91, maxDays: null },
] as const;

export type AgingBucketKey = (typeof AGING_BUCKETS)[number]['key'];

export const agingBucketSchema = z.object({
  key: z.enum(['NOT_DUE', 'DAYS_1_30', 'DAYS_31_60', 'DAYS_61_90', 'DAYS_90_PLUS']),
  label: z.string(),
  amount: z.number(),
  documentCount: z.number().int(),
});

export type AgingBucket = z.infer<typeof agingBucketSchema>;

export const agingReportSchema = z.object({
  companyId: z.string().uuid(),
  companyTitle: z.string(),
  currency: z.string(),
  buckets: z.array(agingBucketSchema),
  totalOpen: z.number(),
  totalOverdue: z.number(),
  /** En eski açık belgenin gecikme günü — tahsilat önceliğini belirler. */
  oldestOverdueDays: z.number().int(),
  calculatedAt: z.string(),
});

export type AgingReport = z.infer<typeof agingReportSchema>;

export const agingQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
});

export type AgingQuery = z.infer<typeof agingQuerySchema>;

// ---------------------------------------------------------------------------
// Tahsilat
// ---------------------------------------------------------------------------

export const PaymentMethod = {
  CASH: 'CASH',
  BANK_TRANSFER: 'BANK_TRANSFER',
  CREDIT_CARD: 'CREDIT_CARD',
  CHEQUE: 'CHEQUE',
  PROMISSORY_NOTE: 'PROMISSORY_NOTE',
  DBS: 'DBS',
} as const;

export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Nakit',
  BANK_TRANSFER: 'Havale / EFT',
  CREDIT_CARD: 'Kredi Kartı',
  CHEQUE: 'Çek',
  PROMISSORY_NOTE: 'Senet',
  DBS: 'DBS',
};

export const PaymentStatus = {
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;

export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  PENDING: 'Onay Bekliyor',
  CONFIRMED: 'Onaylandı',
  FAILED: 'Başarısız',
  CANCELLED: 'İptal Edildi',
};

/**
 * Portalden dogrudan onaylanabilen yontemler. Nakit ve cek fiziksel teslim
 * gerektirdigi icin PENDING dogar; muhasebe elden dogrular.
 */
export const SELF_CONFIRMING_METHODS: readonly PaymentMethod[] = [
  PaymentMethod.CREDIT_CARD,
  PaymentMethod.DBS,
];

export const recordPaymentSchema = z.object({
  /** Plasiyer saha tahsilatında zorunlu; işletme kullanıcısında yok sayılır. */
  companyId: z.string().uuid().optional(),
  method: z.nativeEnum(PaymentMethod),
  amount: z
    .number()
    .positive('Tutar sıfırdan büyük olmalıdır.')
    .max(99999999, 'Tutar çok yüksek.'),
  receivedAt: z.string().datetime({ offset: true }).optional(),
  reference: z.string().trim().max(64).optional(),
  note: z.string().trim().max(280).optional(),
  /**
   * Kapatılacak belgeler. Boş bırakılırsa tahsilat en eski açık belgeden
   * başlayarak otomatik dağıtılır (FIFO).
   */
  allocations: z
    .array(
      z.object({
        entryId: z.string().uuid(),
        amount: z.number().positive(),
      }),
    )
    .max(100)
    .optional(),
});

export type RecordPaymentRequest = z.infer<typeof recordPaymentSchema>;

export const cancelPaymentSchema = z.object({
  reason: z.string().trim().min(3, 'Gerekçe zorunludur.').max(280),
});

export type CancelPaymentRequest = z.infer<typeof cancelPaymentSchema>;

export const paymentAllocationViewSchema = z.object({
  entryId: z.string().uuid(),
  documentNumber: z.string(),
  entryDate: z.string(),
  amount: z.number(),
});

export type PaymentAllocationView = z.infer<typeof paymentAllocationViewSchema>;

export const paymentViewSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  companyTitle: z.string(),
  method: z.nativeEnum(PaymentMethod),
  methodLabel: z.string(),
  status: z.nativeEnum(PaymentStatus),
  statusLabel: z.string(),
  amount: z.number(),
  currency: z.string(),
  receivedAt: z.string(),
  reference: z.string().nullable(),
  note: z.string().nullable(),
  recordedByName: z.string(),
  isFieldCollection: z.boolean(),
  confirmedAt: z.string().nullable(),
  /** Tahsilatın kapattığı belgeler — dağıtılamayan kısım avans olarak kalır. */
  allocations: z.array(paymentAllocationViewSchema),
  unallocatedAmount: z.number(),
});

export type PaymentView = z.infer<typeof paymentViewSchema>;

export const paymentListQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
  status: z.nativeEnum(PaymentStatus).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Yalnızca kendi saha tahsilatları — plasiyerin kasa mutabakatı. */
  onlyMine: z.coerce.boolean().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type PaymentListQuery = z.infer<typeof paymentListQuerySchema>;

export const paymentPageSchema = z.object({
  payments: z.array(paymentViewSchema),
  totalCount: z.number().int(),
  totalAmount: z.number(),
  hasMore: z.boolean(),
});

export type PaymentPage = z.infer<typeof paymentPageSchema>;
