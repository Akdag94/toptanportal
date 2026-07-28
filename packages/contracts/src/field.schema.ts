/**
 * ToptanPortal - Saha Yonetimi Sozlesmeleri
 *
 * Kapsam: bayi portfoyu, ziyaret notlari, satis hedefi ve prim.
 *
 * KAPSAM KURALI: plasiyer YALNIZCA kendisine atanmis bayileri gorur. Bu kural
 * sunucuda `SalesRepAssignment` uzerinden uygulanir; istemcinin gonderdigi
 * hicbir suzgec kapsami GENISLETEMEZ, yalnizca daraltabilir. Portfoy, ticari
 * bir sinirdir: bir plasiyerin baska bir plasiyerin bayisini gormesi, musteri
 * listesinin rakip temsilciye gecmesi demektir.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Bayi portfoyu
// ---------------------------------------------------------------------------

export const companyListItemSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  logoCariCode: z.string(),
  city: z.string().nullable(),
  district: z.string().nullable(),
  phone: z.string().nullable(),
  isActive: z.boolean(),
  isBlocked: z.boolean(),
  /** Kor Siparis Modunda ve yetkisiz rolde GELMEZ. */
  balance: z.number().optional(),
  overdueAmount: z.number().optional(),
  creditLimit: z.number().optional(),
  currency: z.string(),
  /** Son siparis tarihi - portfoyde "unutulmus" bayiyi gosterir. */
  lastOrderAt: z.string().nullable(),
  lastVisitAt: z.string().nullable(),
  /** Bu ayki siparis toplami. */
  monthlyOrderTotal: z.number().optional(),
  assignedRepName: z.string().nullable(),
});

export type CompanyListItem = z.infer<typeof companyListItemSchema>;

export const companyListQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  city: z.string().trim().max(64).optional(),
  /** Yalnizca borcu vadesi gecmis bayiler. */
  onlyOverdue: z.coerce.boolean().optional(),
  /** Bu gun sayisindan uzun suredir siparis vermeyenler. */
  idleDays: z.coerce.number().int().min(1).max(365).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type CompanyListQuery = z.infer<typeof companyListQuerySchema>;

export const companyPageSchema = z.object({
  companies: z.array(companyListItemSchema),
  totalCount: z.number().int(),
  hasMore: z.boolean(),
});

export type CompanyPage = z.infer<typeof companyPageSchema>;

/** Plasiyer atamasi. Yalnizca COMPANY_MANAGE yetkisiyle yapilir. */
export const assignRepSchema = z.object({
  salesRepUserId: z.string().uuid(),
  companyIds: z.array(z.string().uuid()).min(1).max(200),
  /** false ise atama kaldirilir. */
  assign: z.boolean().default(true),
});

export type AssignRepRequest = z.infer<typeof assignRepSchema>;

// ---------------------------------------------------------------------------
// Ziyaret notlari
// ---------------------------------------------------------------------------

export const VisitOutcome = {
  ORDER_TAKEN: 'ORDER_TAKEN',
  NO_ORDER: 'NO_ORDER',
  COMPLAINT: 'COMPLAINT',
  COLLECTION: 'COLLECTION',
  INTRODUCTION: 'INTRODUCTION',
} as const;

export type VisitOutcome = (typeof VisitOutcome)[keyof typeof VisitOutcome];

export const VISIT_OUTCOME_LABELS: Record<VisitOutcome, string> = {
  ORDER_TAKEN: 'Sipariş Alındı',
  NO_ORDER: 'Sipariş Alınamadı',
  COMPLAINT: 'Şikâyet / Sorun',
  COLLECTION: 'Tahsilat',
  INTRODUCTION: 'Tanıtım / İlk Ziyaret',
};

export const createVisitNoteSchema = z.object({
  companyId: z.string().uuid(),
  outcome: z.nativeEnum(VisitOutcome),
  note: z.string().trim().min(3, 'Not en az 3 karakter olmalıdır.').max(1000),
  /**
   * Ziyaret konumu. Plasiyerin sahada oldugunu DOGRULAMAZ, yalnizca kaydeder;
   * konum dogrulamasi bir gozetim aracidir ve bu urunun amaci degildir.
   */
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  /** Bir sonraki ziyaret icin hatirlatma. */
  followUpDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  visitedAt: z.string().datetime({ offset: true }).optional(),
});

export type CreateVisitNoteRequest = z.infer<typeof createVisitNoteSchema>;

export const visitNoteSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  companyTitle: z.string(),
  outcome: z.nativeEnum(VisitOutcome),
  outcomeLabel: z.string(),
  note: z.string(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  followUpDate: z.string().nullable(),
  visitedAt: z.string(),
  authorName: z.string(),
  createdAt: z.string(),
});

export type VisitNote = z.infer<typeof visitNoteSchema>;

export const visitNoteQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
  outcome: z.nativeEnum(VisitOutcome).optional(),
  /** Yalnizca takip tarihi bugun veya gecmiste olanlar - gunun is listesi. */
  dueOnly: z.coerce.boolean().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type VisitNoteQuery = z.infer<typeof visitNoteQuerySchema>;

export const visitNotePageSchema = z.object({
  notes: z.array(visitNoteSchema),
  totalCount: z.number().int(),
  hasMore: z.boolean(),
  /** Takibi gecikmis ziyaret sayisi - gunun basinda ilk bakilan sayidir. */
  overdueFollowUps: z.number().int(),
});

export type VisitNotePage = z.infer<typeof visitNotePageSchema>;

// ---------------------------------------------------------------------------
// Hedef ve prim
// ---------------------------------------------------------------------------

/**
 * Hedef donem BAZINDADIR (yil-ay). Gunluk hedef tutmayiz: satis, ay icinde
 * dalgalanir ve gunluk bir hedef, plasiyeri ay sonunda toparlanacak bir
 * gecikmede gereksiz yere basarisiz gosterir.
 */
export const salesTargetSchema = z.object({
  id: z.string().uuid(),
  salesRepUserId: z.string().uuid(),
  salesRepName: z.string(),
  period: z.string(),
  targetAmount: z.number(),
  /**
   * Gerceklesen ciro. ONAYLANMIS siparisler uzerinden hesaplanir; iptal edilen
   * veya reddedilen siparis hedefe sayilmaz - aksi halde prim, teslim
   * edilmemis mal uzerinden odenirdi.
   */
  achievedAmount: z.number(),
  achievementRate: z.number(),
  currency: z.string(),
  /** Prim orani (yuzde). Hedefin altinda kalindiysa prim hesaplanmaz. */
  commissionRate: z.number(),
  commissionAmount: z.number(),
  /** Tahsilat sarti: prim, tahsil edilmemis ciro uzerinden odenmez. */
  collectedAmount: z.number(),
  collectionRate: z.number(),
  updatedAt: z.string(),
});

export type SalesTarget = z.infer<typeof salesTargetSchema>;

export const salesTargetQuerySchema = z.object({
  /** YYYY-AA. Verilmezse icinde bulunulan ay. */
  period: z.string().regex(/^\d{4}-\d{2}$/, 'Dönem YYYY-AA biçiminde olmalıdır.').optional(),
  salesRepUserId: z.string().uuid().optional(),
});

export type SalesTargetQuery = z.infer<typeof salesTargetQuerySchema>;

export const upsertSalesTargetSchema = z.object({
  salesRepUserId: z.string().uuid(),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  targetAmount: z.number().nonnegative().max(999999999),
  commissionRate: z.number().min(0).max(100),
});

export type UpsertSalesTargetRequest = z.infer<typeof upsertSalesTargetSchema>;
