/**
 * ToptanPortal - Sanal POS (3D Secure) ve DBS Sozlesmeleri
 *
 * KART VERISI BU SOZLESMEDE YOKTUR VE HIC OLMAYACAKTIR.
 *
 * Kart numarasi, son kullanma tarihi ve CVV portal sunucusuna UGRAMAZ:
 * kullanici bankanin 3D sayfasina yonlendirilir, kart bilgisini oraya girer.
 * Portalin gordugu tek sey, bankanin geri gonderdigi sonuc ve maskeli karttir.
 *
 * Neden: kart verisi sunucudan bir kez gecerse, o sunucu PCI-DSS kapsamina
 * girer - loglari, yedekleri, hata izleri ve bellek dokumleri dahil. Kapsam
 * disinda kalmanin tek guvenilir yolu, veriyi hic gormemektir.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// 3D Secure odeme akisi
// ---------------------------------------------------------------------------

export const PosTransactionStatus = {
  /** Banka formu uretildi, kullanici henuz donmedi. */
  INITIATED: 'INITIATED',
  /** Banka 3D dogrulamasini onayladi, tahsilat tamamlandi. */
  SUCCEEDED: 'SUCCEEDED',
  /** Banka reddetti veya kullanici vazgecti. */
  FAILED: 'FAILED',
  /**
   * Banka yaniti alindi ama portal tarafinda islenemedi. INSAN BAKACAK:
   * para cekilmis olabilir. Bu durum sessizce basarisiz sayilmaz.
   */
  NEEDS_REVIEW: 'NEEDS_REVIEW',
} as const;

export type PosTransactionStatus =
  (typeof PosTransactionStatus)[keyof typeof PosTransactionStatus];

export const POS_TRANSACTION_STATUS_LABELS: Record<PosTransactionStatus, string> = {
  INITIATED: 'Başlatıldı',
  SUCCEEDED: 'Başarılı',
  FAILED: 'Başarısız',
  NEEDS_REVIEW: 'İnceleme Bekliyor',
};

export const startCardPaymentSchema = z.object({
  companyId: z.string().uuid().optional(),
  amount: z
    .number()
    .positive('Tutar sıfırdan büyük olmalıdır.')
    .max(99999999, 'Tutar çok yüksek.'),
  /**
   * Taksit sayisi. 1 pesin demektir. Toptanci tarafinda taksit maliyeti
   * bankaya odenir; izin verilen aralik sunucuda dogrulanir.
   */
  installment: z.number().int().min(1).max(12).default(1),
  /** Kapatilacak belgeler; bos ise en eski vadeden baslanarak dagitilir. */
  allocations: z
    .array(z.object({ entryId: z.string().uuid(), amount: z.number().positive() }))
    .max(100)
    .optional(),
});

export type StartCardPaymentRequest = z.infer<typeof startCardPaymentSchema>;

/**
 * Bankaya gonderilecek form. Arayuz bu alanlari gizli input olarak basar ve
 * formu OTOMATIK gonderir; kullanici bankanin 3D sayfasinda uyanir.
 *
 * Alanlar bankadan bankaya degisir, bu yuzden serbest bir sozluktur. Sabit bir
 * alan listesi tanimlamak, ikinci bankayi eklerken sozlesmeyi kirardi.
 */
export const cardPaymentFormSchema = z.object({
  transactionId: z.string().uuid(),
  /** Bankanin 3D dogrulama sayfasi. */
  actionUrl: z.string().url(),
  method: z.literal('POST'),
  fields: z.record(z.string()),
  /** Kullanicinin bankada geciremeyecegi azami sure (saniye). */
  expiresIn: z.number().int(),
});

export type CardPaymentForm = z.infer<typeof cardPaymentFormSchema>;

export const posTransactionViewSchema = z.object({
  id: z.string().uuid(),
  status: z.nativeEnum(PosTransactionStatus),
  statusLabel: z.string(),
  amount: z.number(),
  currency: z.string(),
  installment: z.number().int(),
  /** Yalnizca maskeli kart: "454671******7894". Tam numara SAKLANMAZ. */
  maskedPan: z.string().nullable(),
  cardBrand: z.string().nullable(),
  bankName: z.string().nullable(),
  /** Banka islem kimligi - itiraz ve mutabakatta bankaya bu verilir. */
  providerRef: z.string().nullable(),
  /** Basarisizlikta bankanin verdigi kod; kullaniciya cevrilerek gosterilir. */
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  /** Tahsilat kaydi - yalnizca basarili islemde olusur. */
  paymentId: z.string().uuid().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});

export type PosTransactionView = z.infer<typeof posTransactionViewSchema>;

// ---------------------------------------------------------------------------
// DBS - Dogrudan Borclandirma Sistemi
//
// Bayinin bankasi, toptancinin kestigi faturayi bayinin DBS limitinden tahsil
// eder. Akis dosya tabanlidir: toptanci borc dosyasi yukler, banka gun sonunda
// sonuc dosyasi doner.
// ---------------------------------------------------------------------------

export const DbsFileKind = {
  /** Bankaya gonderilen borc kayitlari. */
  DEBT: 'DEBT',
  /** Bankadan donen tahsilat sonuclari. */
  RESULT: 'RESULT',
} as const;

export type DbsFileKind = (typeof DbsFileKind)[keyof typeof DbsFileKind];

export const DbsRecordStatus = {
  PENDING: 'PENDING',
  COLLECTED: 'COLLECTED',
  REJECTED: 'REJECTED',
} as const;

export type DbsRecordStatus = (typeof DbsRecordStatus)[keyof typeof DbsRecordStatus];

export const DBS_RECORD_STATUS_LABELS: Record<DbsRecordStatus, string> = {
  PENDING: 'Bankada Bekliyor',
  COLLECTED: 'Tahsil Edildi',
  REJECTED: 'Tahsil Edilemedi',
};

export const dbsExportQuerySchema = z.object({
  /** Bu tarihe kadar vadesi gelen açık belgeler dosyaya girer. */
  dueUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Tarih YYYY-AA-GG biçiminde olmalıdır.'),
  bankCode: z.string().trim().min(2).max(8),
  companyIds: z.array(z.string().uuid()).max(500).optional(),
});

export type DbsExportQuery = z.infer<typeof dbsExportQuerySchema>;

export const dbsRecordViewSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  companyTitle: z.string(),
  entryId: z.string().uuid(),
  documentNumber: z.string(),
  dueDate: z.string(),
  amount: z.number(),
  currency: z.string(),
  status: z.nativeEnum(DbsRecordStatus),
  statusLabel: z.string(),
  rejectReason: z.string().nullable(),
});

export type DbsRecordView = z.infer<typeof dbsRecordViewSchema>;

export const dbsBatchViewSchema = z.object({
  id: z.string().uuid(),
  bankCode: z.string(),
  kind: z.nativeEnum(DbsFileKind),
  fileName: z.string(),
  recordCount: z.number().int(),
  totalAmount: z.number(),
  currency: z.string(),
  createdByName: z.string(),
  createdAt: z.string(),
  /** Sonuc dosyasi islendiginde dolar. */
  processedAt: z.string().nullable(),
  collectedCount: z.number().int(),
  rejectedCount: z.number().int(),
});

export type DbsBatchView = z.infer<typeof dbsBatchViewSchema>;

/**
 * Banka sonuc dosyasinin yuklenmesi. Icerik metin olarak gonderilir; dosya
 * bicimi bankaya gore degisir ve sunucuda ayrilir.
 */
export const dbsImportSchema = z.object({
  bankCode: z.string().trim().min(2).max(8),
  fileName: z.string().trim().max(160),
  content: z.string().min(1).max(2_000_000),
});

export type DbsImportRequest = z.infer<typeof dbsImportSchema>;

export const dbsImportResultSchema = z.object({
  batchId: z.string().uuid(),
  collectedCount: z.number().int(),
  collectedAmount: z.number(),
  rejectedCount: z.number().int(),
  /** Portalde karsiligi bulunamayan satirlar - elle incelenir. */
  unmatchedLines: z.array(z.string()).max(200),
});

export type DbsImportResult = z.infer<typeof dbsImportResultSchema>;
