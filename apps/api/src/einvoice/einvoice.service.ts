/**
 * ToptanPortal API - e-Belge Arsivi
 *
 * Bayi yalnizca KENDI belgelerini gorur; kapsam CompanyScopeService uzerinden
 * cozulur ve sorguya companyId olarak girer. Yetki denetimini listeleme
 * sonrasina birakmak - "cek, sonra filtrele" - bir sayfalama hatasinda
 * baskasinin faturasini sizdirir.
 *
 * INDIRME iki adimlidir:
 *   1. Oturumlu istek, kisa omurlu IMZALI bir baglanti alir.
 *   2. Tarayici o baglantiyi dogrudan cagirir; dosya akitilir.
 *
 * Neden iki adim: 10 yillik arsivde tek bir toplu indirme, uygulama surecinden
 * gecerse sunucuyu dakikalarca mesgul eder. Imzali baglanti ayrica belgeyi
 * indiren kisiyi tasir - erisim kaydi bu sayede oturumsuz uctan da yazilabilir.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@toptanportal/db';
import {
  EDOCUMENT_KIND_LABELS,
  EDOCUMENT_STATUS_LABELS,
  EDocumentFormat,
  EDocumentStatus,
  ErrorCode,
  type EDocument,
  type EDocumentLink,
  type EDocumentPage,
  type EDocumentQuery,
  type EDocumentSummary,
} from '@toptanportal/contracts';

import type { AppConfig } from '../config/configuration';
import { ApiException } from '../common/exceptions/api.exception';
import { CompanyScopeService } from '../common/context/company-scope.service';
import { DocumentStorageService } from './document-storage.service';
import type { ReadStream } from 'node:fs';
import { PrismaService } from '../common/prisma/prisma.service';
import type { AuthenticatedPrincipal } from '../common/context/request-context';

const DOCUMENT_INCLUDE = {
  company: { select: { title: true, taxNumber: true } },
  order: { select: { orderNumber: true } },
} as const;

type DocumentRow = Prisma.EDocumentGetPayload<{ include: typeof DOCUMENT_INCLUDE }>;

export interface DownloadTicket {
  documentId: string;
  userId: string;
  format: EDocumentFormat;
}

@Injectable()
export class EInvoiceService {
  private readonly logger = new Logger(EInvoiceService.name);
  private readonly config: AppConfig;

  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly scope: CompanyScopeService,
    private readonly storage: DocumentStorageService,
  ) {
    this.config = configService.getOrThrow<AppConfig>('app');
  }

  // -------------------------------------------------------------------------
  // Listeleme
  // -------------------------------------------------------------------------

  async list(
    principal: AuthenticatedPrincipal,
    query: EDocumentQuery,
  ): Promise<EDocumentPage> {
    const companyFilter = await this.scope.listFilter(principal, query.companyId);

    const where: Prisma.EDocumentWhereInput = {
      tenantId: principal.tenantId,
      ...companyFilter,
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to
        ? {
            issueDate: {
              ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
              ...(query.to ? { lte: new Date(`${query.to}T23:59:59.999Z`) } : {}),
            },
          }
        : {}),
      ...(query.q
        ? {
            OR: [
              { documentNumber: { contains: query.q, mode: 'insensitive' } },
              /* ETTN tam eslesme ile aranir: UUID'nin parcasiyla arama, tum
                 tabloyu tarayan ve indeksten yararlanmayan bir sorgu uretir. */
              ...(isUuid(query.q) ? [{ uuid: query.q }] : []),
            ],
          }
        : {}),
    };

    const [belgeler, toplam, tutarlar] = await Promise.all([
      this.prisma.eDocument.findMany({
        where,
        include: DOCUMENT_INCLUDE,
        orderBy: [{ issueDate: 'desc' }, { documentNumber: 'desc' }],
        skip: query.offset,
        take: query.limit,
      }),
      this.prisma.eDocument.count({ where }),
      this.prisma.eDocument.aggregate({ where, _sum: { grandTotal: true } }),
    ]);

    return {
      documents: belgeler.map((belge) => this.toView(belge)),
      totalCount: toplam,
      hasMore: query.offset + belgeler.length < toplam,
      totalAmount: tutarlar._sum.grandTotal?.toNumber() ?? 0,
      currency: belgeler[0]?.currency ?? 'TRY',
    };
  }

  /**
   * Donem ozeti. Toplamlar VERITABANINDA hesaplanir; sayfalanmis listeyi
   * istemcide toplamak, ikinci sayfayi gormeyen bir mutabakat uretir.
   */
  async summary(
    principal: AuthenticatedPrincipal,
    query: EDocumentQuery,
  ): Promise<EDocumentSummary> {
    const companyFilter = await this.scope.listFilter(principal, query.companyId);

    const from = query.from ?? varsayilanDonemBasi();
    const to = query.to ?? bugun();

    const where: Prisma.EDocumentWhereInput = {
      tenantId: principal.tenantId,
      ...companyFilter,
      issueDate: {
        gte: new Date(`${from}T00:00:00.000Z`),
        lte: new Date(`${to}T23:59:59.999Z`),
      },
    };

    const [turBazinda, sorunlu, genel] = await Promise.all([
      this.prisma.eDocument.groupBy({
        by: ['kind'],
        where,
        _count: { _all: true },
        _sum: { grandTotal: true },
      }),
      this.prisma.eDocument.count({
        where: {
          ...where,
          status: { in: [EDocumentStatus.REJECTED, EDocumentStatus.FAILED] },
        },
      }),
      this.prisma.eDocument.aggregate({
        where,
        _count: { _all: true },
        _sum: { grandTotal: true },
      }),
    ]);

    return {
      from,
      to,
      currency: 'TRY',
      byKind: turBazinda.map((satir) => ({
        kind: satir.kind,
        kindLabel: EDOCUMENT_KIND_LABELS[satir.kind],
        count: satir._count._all,
        totalAmount: satir._sum.grandTotal?.toNumber() ?? 0,
      })),
      problemCount: sorunlu,
      totalCount: genel._count._all,
      totalAmount: genel._sum.grandTotal?.toNumber() ?? 0,
    };
  }

  // -------------------------------------------------------------------------
  // Indirme
  // -------------------------------------------------------------------------

  async createLink(
    principal: AuthenticatedPrincipal,
    documentId: string,
    format: EDocumentFormat,
  ): Promise<EDocumentLink> {
    const belge = await this.loadInScope(principal, documentId);
    const yol = this.pathFor(belge, format);

    if (yol === null) {
      throw ApiException.notFound(
        ErrorCode.RESOURCE_NOT_FOUND,
        `Bu belgenin ${format} kopyası arşivde bulunmuyor.`,
      );
    }

    const dosya = await this.storage.open(yol);

    if (dosya === null) {
      /* Veritabani belgeyi biliyor, depo bilmiyor. Kullaniciya "bulunamadi"
         demek yeterli degil - bu bir ARSIV TUTARSIZLIGIDIR ve saklama
         yukumlulugunu tehlikeye atar. */
      this.logger.error(
        `Arşiv tutarsızlığı: ${belge.documentNumber} (${belge.id}) kaydı var, dosyası yok.`,
      );
      throw ApiException.notFound(ErrorCode.RESOURCE_NOT_FOUND, 'Belge dosyası bulunamadı.');
    }

    dosya.stream.destroy();

    const ticket: DownloadTicket = { documentId: belge.id, userId: principal.userId, format };
    const token = this.signTicket(ticket);

    return {
      url: `${this.config.API_BASE_URL}/api/v1/e-documents/file?token=${encodeURIComponent(token)}`,
      fileName: this.fileNameFor(belge, format),
      format,
      contentHash: belge.contentHash,
      sizeBytes: dosya.sizeBytes,
      expiresIn: this.config.EDOCUMENT_LINK_TTL_SECONDS,
    };
  }

  /**
   * Toplu indirme: her belge icin ayri imzali baglanti uretir.
   *
   * TEK BIR ZIP URETILMEZ. Bes yuz belgeyi bellekte paketlemek, es zamanli iki
   * talepte sunucuyu tuketir; ayrica paket yarida kesilirse kullanici hangi
   * belgelerin indigini bilemez. Ayri baglantilar, tarayicinin indirme
   * yoneticisine devredilebilir ve tek tek yeniden denenebilir.
   *
   * Kapsam denetimi HER belge icin ayri yapilir: listenin bir kimligi
   * baskasina aitse yalnizca o belge dusurulur, istek tumden reddedilmez -
   * ama dusurulen belge sessizce yok sayilmaz, sayisi donulur.
   */
  async createBulkLinks(
    principal: AuthenticatedPrincipal,
    documentIds: string[],
    format: EDocumentFormat,
  ): Promise<{ links: EDocumentLink[]; skippedCount: number }> {
    const links: EDocumentLink[] = [];
    let atlanan = 0;

    for (const documentId of documentIds) {
      try {
        links.push(await this.createLink(principal, documentId, format));
      } catch {
        atlanan += 1;
      }
    }

    return { links, skippedCount: atlanan };
  }

  /**
   * Imzali baglantiyi cozer. Sure dolmussa veya imza tutmuyorsa null doner;
   * cagiran taraf 403 dondurur ve HICBIR belge bilgisi sizdirmaz.
   */
  verifyTicket(token: string): DownloadTicket | null {
    const [govde, imza] = token.split('.');

    if (!govde || !imza) return null;

    const beklenen = this.hmac(govde);
    const gelenTampon = Buffer.from(imza, 'base64url');
    const beklenenTampon = Buffer.from(beklenen, 'base64url');

    /* Sabit zamanli karsilastirma: imzayi bayt bayt deneyerek uretmeye
       calisan bir saldiriya sure bilgisi vermeyiz. */
    if (
      gelenTampon.length !== beklenenTampon.length ||
      !timingSafeEqual(gelenTampon, beklenenTampon)
    ) {
      return null;
    }

    try {
      const veri = JSON.parse(Buffer.from(govde, 'base64url').toString('utf8')) as
        | (DownloadTicket & { exp: number })
        | null;

      if (!veri || typeof veri.exp !== 'number' || veri.exp < Date.now()) return null;

      return { documentId: veri.documentId, userId: veri.userId, format: veri.format };
    } catch {
      return null;
    }
  }

  /**
   * Dosyayi acar ve ERISIMI KAYDEDER.
   *
   * Kayit, dosya akitilmadan once yazilir: akitma sirasinda baglanti koparsa
   * bile belge sunucudan cikmistir ve erisim gerceklesmis sayilir. Sonradan
   * yazmak, yarida kesilen indirmeleri gorunmez kilardi.
   */
  async openForTicket(
    ticket: DownloadTicket,
    ip: string | null,
  ): Promise<{ document: DocumentRow; stream: ReadStream; fileName: string } | null> {
    const belge = await this.prisma.eDocument.findUnique({
      where: { id: ticket.documentId },
      include: DOCUMENT_INCLUDE,
    });

    if (!belge) return null;

    const yol = this.pathFor(belge, ticket.format);
    if (yol === null) return null;

    const dosya = await this.storage.open(yol);
    if (dosya === null) return null;

    await this.prisma.eDocumentAccess.create({
      data: {
        documentId: belge.id,
        userId: ticket.userId,
        format: ticket.format,
        ip,
      },
    });

    return {
      document: belge,
      stream: dosya.stream,
      fileName: this.fileNameFor(belge, ticket.format),
    };
  }

  // -------------------------------------------------------------------------
  // Yardimcilar
  // -------------------------------------------------------------------------

  private async loadInScope(
    principal: AuthenticatedPrincipal,
    documentId: string,
  ): Promise<DocumentRow> {
    const belge = await this.prisma.eDocument.findFirst({
      where: { id: documentId, tenantId: principal.tenantId },
      include: DOCUMENT_INCLUDE,
    });

    if (!belge) {
      throw ApiException.notFound(ErrorCode.RESOURCE_NOT_FOUND, 'Belge bulunamadı.');
    }

    await this.scope.resolve(principal, belge.companyId);
    return belge;
  }

  private pathFor(belge: DocumentRow, format: EDocumentFormat): string | null {
    switch (format) {
      case EDocumentFormat.XML:
        return belge.xmlPath;
      case EDocumentFormat.PDF:
        return belge.pdfPath;
      case EDocumentFormat.ENVELOPE:
        return belge.envelopePath;
      default:
        return null;
    }
  }

  private fileNameFor(belge: DocumentRow, format: EDocumentFormat): string {
    const uzanti = format === EDocumentFormat.PDF ? 'pdf' : format === EDocumentFormat.XML ? 'xml' : 'zip';
    return `${belge.documentNumber}.${uzanti}`;
  }

  private signTicket(ticket: DownloadTicket): string {
    const govde = Buffer.from(
      JSON.stringify({
        ...ticket,
        exp: Date.now() + this.config.EDOCUMENT_LINK_TTL_SECONDS * 1000,
      }),
    ).toString('base64url');

    return `${govde}.${this.hmac(govde)}`;
  }

  private hmac(value: string): string {
    return createHmac('sha256', this.config.JWT_ACCESS_SECRET).update(value).digest('base64url');
  }

  private toView(belge: DocumentRow): EDocument {
    return {
      id: belge.id,
      kind: belge.kind,
      kindLabel: EDOCUMENT_KIND_LABELS[belge.kind],
      status: belge.status,
      statusLabel: EDOCUMENT_STATUS_LABELS[belge.status],
      documentNumber: belge.documentNumber,
      uuid: belge.uuid,
      issueDate: belge.issueDate.toISOString(),
      companyId: belge.companyId,
      companyTitle: belge.company.title,
      taxNumber: belge.company.taxNumber,
      netAmount: belge.netAmount.toNumber(),
      vatAmount: belge.vatAmount.toNumber(),
      grandTotal: belge.grandTotal.toNumber(),
      currency: belge.currency,
      orderId: belge.orderId,
      orderNumber: belge.order?.orderNumber ?? null,
      despatchDate: belge.despatchDate?.toISOString() ?? null,
      responseNote: belge.responseNote,
      contentHash: belge.contentHash,
      sentAt: belge.sentAt?.toISOString() ?? null,
      respondedAt: belge.respondedAt?.toISOString() ?? null,
      createdAt: belge.createdAt.toISOString(),
    };
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function bugun(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Varsayilan donem: icinde bulunulan ayin basi. */
function varsayilanDonemBasi(): string {
  const simdi = new Date();
  return new Date(Date.UTC(simdi.getUTCFullYear(), simdi.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
}
