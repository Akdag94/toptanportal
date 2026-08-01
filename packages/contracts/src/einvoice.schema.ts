/**
 * ToptanPortal - e-Belge Arsivi Sozlesmeleri
 *
 * KAPSAM: e-Fatura, e-Arsiv Fatura ve e-Irsaliye. Ucu de GIB'e (Gelir Idaresi
 * Baskanligi) elektronik olarak iletilen ve UBL-TR 1.2 bicimindeki XML'i
 * HUKUKI ASIL olan belgelerdir.
 *
 * PDF ASIL DEGILDIR. PDF, imzali XML'in insan icin uretilmis bir goruntusudur;
 * ihtilaf halinde mahkemeye XML sunulur. Bu yuzden arsiv XML uzerine kurulur ve
 * PDF her zaman ondan turetilir - tersi degil. Yeniden uretilen bir PDF ile
 * imzalanmis XML birbirini tutmazsa, dogru olan XML'dir.
 *
 * SAKLAMA SURESI: VUK 253 uyarinca 10 yil (ilgili takvim yilini izleyen yildan
 * baslar). Bu sure icinde belge SILINEMEZ; portal silme ucu sunmaz.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Belge turleri
// ---------------------------------------------------------------------------

export const EDocumentKind = {
  /** GIB e-Fatura - alici da e-Fatura mukellefi. */
  EINVOICE: 'EINVOICE',
  /** e-Arsiv Fatura - alici e-Fatura mukellefi degil. */
  EARCHIVE: 'EARCHIVE',
  /** e-Irsaliye - sevkiyata eslik eder. */
  EDESPATCH: 'EDESPATCH',
} as const;

export type EDocumentKind = (typeof EDocumentKind)[keyof typeof EDocumentKind];

export const EDOCUMENT_KIND_LABELS: Record<EDocumentKind, string> = {
  EINVOICE: 'e-Fatura',
  EARCHIVE: 'e-Arşiv Fatura',
  EDESPATCH: 'e-İrsaliye',
};

/**
 * Belgenin GIB tarafindaki durumu.
 *
 * `ACCEPTED` ile `DELIVERED` ayri tutulur: e-Fatura'da alicinin belgeyi kabul
 * veya reddetme hakki vardir ve bu, ticari sonucu olan bir farktir. Ikisini tek
 * duruma indirmek, reddedilmis bir faturayi tahsil edilebilir gostermek olur.
 */
export const EDocumentStatus = {
  /** Portalde olustu, henuz gonderilmedi. */
  DRAFT: 'DRAFT',
  /** Entegratore iletildi, GIB yaniti bekleniyor. */
  SENT: 'SENT',
  /** GIB kabul etti ve aliciya ulasti. */
  DELIVERED: 'DELIVERED',
  /** Alici ticari faturayi KABUL etti. */
  ACCEPTED: 'ACCEPTED',
  /** Alici REDDETTI - fatura hukuken gecersiz sayilir. */
  REJECTED: 'REJECTED',
  /** GIB veya entegrator reddetti (bicim/mukellef hatasi). */
  FAILED: 'FAILED',
  /** e-Arsiv faturasi iptal edildi. */
  CANCELLED: 'CANCELLED',
} as const;

export type EDocumentStatus = (typeof EDocumentStatus)[keyof typeof EDocumentStatus];

export const EDOCUMENT_STATUS_LABELS: Record<EDocumentStatus, string> = {
  DRAFT: 'Taslak',
  SENT: 'Gönderildi',
  DELIVERED: 'Ulaştı',
  ACCEPTED: 'Kabul Edildi',
  REJECTED: 'Reddedildi',
  FAILED: 'Hatalı',
  CANCELLED: 'İptal Edildi',
};

/** Tahsil edilebilir sayilan durumlar. Reddedilen fatura bu listede DEGILDIR. */
export const COLLECTIBLE_EDOCUMENT_STATUSES: readonly EDocumentStatus[] = [
  EDocumentStatus.DELIVERED,
  EDocumentStatus.ACCEPTED,
];

// ---------------------------------------------------------------------------
// Belge gorunumu
// ---------------------------------------------------------------------------

export const eDocumentSchema = z.object({
  id: z.string().uuid(),
  kind: z.nativeEnum(EDocumentKind),
  kindLabel: z.string(),
  status: z.nativeEnum(EDocumentStatus),
  statusLabel: z.string(),
  /** GIB fatura numarasi: 3 harf + 13 hane (ABC2026000000431). */
  documentNumber: z.string(),
  /**
   * ETTN - Evrensel Tekil Tanimlama Numarasi. Belgeyi GIB nezdinde tekil
   * kilar; mutabakat ve itirazda kullanilan asil anahtardir.
   */
  uuid: z.string(),
  issueDate: z.string(),
  companyId: z.string().uuid(),
  companyTitle: z.string(),
  taxNumber: z.string().nullable(),
  /** KDV haric tutar. */
  netAmount: z.number(),
  vatAmount: z.number(),
  grandTotal: z.number(),
  currency: z.string(),
  /** Faturayi doguran portal siparisi - varsa. */
  orderId: z.string().uuid().nullable(),
  orderNumber: z.string().nullable(),
  /** e-Irsaliyede sevk bilgisi. */
  despatchDate: z.string().nullable(),
  /** Alicinin ret gerekcesi. */
  responseNote: z.string().nullable(),
  /** Belge XML'inin SHA-256 ozeti - indirilen dosyanin dogrulanmasi icin. */
  contentHash: z.string(),
  sentAt: z.string().nullable(),
  respondedAt: z.string().nullable(),
  createdAt: z.string(),
});

export type EDocument = z.infer<typeof eDocumentSchema>;

export const eDocumentQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
  kind: z.nativeEnum(EDocumentKind).optional(),
  status: z.nativeEnum(EDocumentStatus).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Belge numarasi veya ETTN ile arama. */
  q: z.string().trim().max(64).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type EDocumentQuery = z.infer<typeof eDocumentQuerySchema>;

export const eDocumentPageSchema = z.object({
  documents: z.array(eDocumentSchema),
  totalCount: z.number().int(),
  hasMore: z.boolean(),
  /** Listelenen belgelerin toplami - donem mutabakatinda kullanilir. */
  totalAmount: z.number(),
  currency: z.string(),
});

export type EDocumentPage = z.infer<typeof eDocumentPageSchema>;

// ---------------------------------------------------------------------------
// Indirme
// ---------------------------------------------------------------------------

export const EDocumentFormat = {
  /** Hukuki asil. */
  XML: 'XML',
  /** Goruntuleme kopyasi. */
  PDF: 'PDF',
  /** Imzali paket (XML + imza + goruntu). */
  ENVELOPE: 'ENVELOPE',
} as const;

export type EDocumentFormat = (typeof EDocumentFormat)[keyof typeof EDocumentFormat];

export const eDocumentDownloadSchema = z.object({
  documentId: z.string().uuid(),
  format: z.nativeEnum(EDocumentFormat).default(EDocumentFormat.PDF),
});

export type EDocumentDownloadRequest = z.infer<typeof eDocumentDownloadSchema>;

/**
 * Indirme baglantisi. Dosya API uzerinden akitilmaz; kisa omurlu imzali bir
 * baglanti uretilir.
 *
 * Neden: 10 yillik arsivde belge sayisi milyonlari bulur ve bunlari uygulama
 * surecinden gecirmek, tek bir toplu indirmede sunucuyu tuketir. Kisa omur ise
 * baglantinin paylasilmasini anlamsiz kilar.
 */
export const eDocumentLinkSchema = z.object({
  url: z.string(),
  fileName: z.string(),
  format: z.nativeEnum(EDocumentFormat),
  contentHash: z.string(),
  sizeBytes: z.number().int(),
  expiresIn: z.number().int(),
});

export type EDocumentLink = z.infer<typeof eDocumentLinkSchema>;

/**
 * Toplu indirme talebi. Muhasebeci ay sonunda tum donemi tek dosyada ister.
 * Sinir bilincli olarak dusuktur: daha genis bir talep, arsiv sunucusunu
 * dakikalarca mesgul eder ve es zamanli kullanicilar zaman asimina ugrar.
 */
export const eDocumentBulkSchema = z.object({
  documentIds: z.array(z.string().uuid()).min(1).max(500),
  format: z.nativeEnum(EDocumentFormat).default(EDocumentFormat.PDF),
});

export type EDocumentBulkRequest = z.infer<typeof eDocumentBulkSchema>;

// ---------------------------------------------------------------------------
// Uretim hatti
// ---------------------------------------------------------------------------

/**
 * Belge kesme talebi.
 *
 * Belge SIPARISTEN uretilir; serbest kalemli fatura portalin isi degildir.
 * Portalin kestigi her fatura, portalde olusmus ve tutari portalde
 * hesaplanmis bir siparisin karsiligidir - aksi halde ayni fatura hem Logo'da
 * hem portalde farkli tutarlarla var olabilirdi.
 */
export const issueEDocumentSchema = z.object({
  orderId: z.string().uuid(),
  /** e-Fatura mi e-Arsiv mi olacagi ALICININ mukellefligine gore belirlenir. */
  kind: z.nativeEnum(EDocumentKind).optional(),
  note: z.string().trim().max(500).optional(),
});

export type IssueEDocumentRequest = z.infer<typeof issueEDocumentSchema>;

export const issueEDocumentResultSchema = z.object({
  document: eDocumentSchema,
  /**
   * Belgeyi gecersiz kilmayan ama insanin gormesi gereken durumlar
   * (taninmayan birim kodu, eksik vergi dairesi). Sessizce yutulmaz: belge
   * kesilmistir ve geri alinamaz, uyari o yuzden ekranda durur.
   */
  warnings: z.array(z.string()),
});

export type IssueEDocumentResult = z.infer<typeof issueEDocumentResultSchema>;

// ---------------------------------------------------------------------------
// Mutabakat
// ---------------------------------------------------------------------------

/**
 * Donem ozeti. Muhasebecinin "bu ay kac fatura kesildi, toplami ne" sorusunu
 * tek istekte cevaplar; listeyi sayfalayip toplamak yerine sunucuda hesaplanir.
 */
export const eDocumentSummarySchema = z.object({
  from: z.string(),
  to: z.string(),
  currency: z.string(),
  byKind: z.array(
    z.object({
      kind: z.nativeEnum(EDocumentKind),
      kindLabel: z.string(),
      count: z.number().int(),
      totalAmount: z.number(),
    }),
  ),
  /** Reddedilen ve hatali belgeler - once bunlara bakilir. */
  problemCount: z.number().int(),
  totalCount: z.number().int(),
  totalAmount: z.number(),
});

export type EDocumentSummary = z.infer<typeof eDocumentSummarySchema>;
