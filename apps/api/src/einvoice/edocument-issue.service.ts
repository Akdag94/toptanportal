/**
 * ToptanPortal API - e-Belge Kesme
 *
 * Belge SIPARISTEN uretilir. Serbest kalemli fatura portalin isi degildir:
 * portalin kestigi her fatura, portalde olusmus ve tutari portalde
 * hesaplanmis bir siparisin karsiligidir. Aksi halde ayni fatura Logo'da ve
 * portalde farkli tutarlarla var olabilir ve hangisinin dogru oldugu sorusu
 * mutabakat masasina kalirdi.
 *
 * BELGE KESMEK GERI ALINAMAZ. Numara tuketilir, belge hukuken dogar ve
 * duzeltmesi ancak iade faturasiyla yapilir. Bu yuzden akis boyunca "once
 * dogrula, sonra uret" sirasi korunur ve supheli her durumda belge HIC
 * uretilmez.
 *
 * ISLEM SIRASI KASITLIDIR:
 *
 *   1. Kiraci bazli danisma kilidi alinir (numara tekrarini onler).
 *   2. Sonraki belge numarasi okunur.
 *   3. XML uretilir.
 *   4. Dosya ARSIVE YAZILIR.
 *   5. Kayit veritabanina yazilir ve islem kapanir.
 *
 * Dosyanin kayittan ONCE yazilmasi bilerekdir. Kayit once yazilsaydi ve dosya
 * yazimi basarisiz olsaydi, veritabani "belge var" derken arsiv bos kalirdi -
 * bu, saklama yukumlulugunun ihlalidir ve ancak indirme denendiginde, yani
 * aylar sonra fark edilir. Ters sirada ise en kotu ihtimalle sahipsiz bir
 * dosya kalir: hicbir kaydin isaret etmedigi, kimseyi yaniltmayan bir dosya.
 *
 * `contentHash` ve `xmlPath` kayda YAZILDIKTAN SONRA degistirilemez (veritabani
 * tetikleyicisi). Bu yuzden ozet, kayit yazilmadan once hesaplanmis olmalidir.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { EDocumentStatus as DbStatus, OrderStatus, Prisma } from '@toptanportal/db';
import {
  AuditAction,
  EDocumentKind,
  ErrorCode,
  type EDocumentKind as Kind,
  type IssueEDocumentRequest,
  type IssueEDocumentResult,
} from '@toptanportal/contracts';

import type { AppConfig } from '../config/configuration';
import { ApiException } from '../common/exceptions/api.exception';
import { AuditService } from '../common/audit/audit.service';
import { DocumentStorageService } from './document-storage.service';
import { EInvoiceService } from './einvoice.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { buildDespatchAdviceXml, buildInvoiceXml, type UblDocumentInput, type UblParty } from './ubl-builder';
import type { AuthenticatedPrincipal } from '../common/context/request-context';

/** GIB belge numarasi: 3 harf + yil (4) + sira (9). */
const SEQUENCE_WIDTH = 9;

@Injectable()
export class EDocumentIssueService {
  private readonly logger = new Logger(EDocumentIssueService.name);
  private readonly config: AppConfig;

  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly storage: DocumentStorageService,
    private readonly einvoice: EInvoiceService,
    private readonly audit: AuditService,
  ) {
    this.config = configService.getOrThrow<AppConfig>('app');
  }

  async issueFromOrder(
    principal: AuthenticatedPrincipal,
    request: IssueEDocumentRequest,
  ): Promise<IssueEDocumentResult> {
    const siparis = await this.prisma.order.findFirst({
      where: { id: request.orderId, tenantId: principal.tenantId },
      include: {
        company: true,
        lines: { orderBy: { lineNumber: 'asc' } },
      },
    });

    if (!siparis) {
      throw ApiException.notFound(ErrorCode.RESOURCE_NOT_FOUND, 'Sipariş bulunamadı.');
    }

    /* Belge yalnizca ONAYLANMIS siparisten kesilir. Onay bekleyen veya
       iletilmemis bir siparisin faturasi, henuz alinmamis bir karari
       belgelemektir; iptal edilmis siparisin faturasi ise hic olmamis bir
       teslimati. Ikisi de iade faturasiyla duzeltilmesi gereken bir belge
       dogurur. */
    if (siparis.status !== OrderStatus.CONFIRMED) {
      throw ApiException.badRequest(
        ErrorCode.VALIDATION_FAILED,
        `Belge yalnızca onaylanmış siparişten kesilir; bu sipariş "${siparis.status}" durumunda.`,
      );
    }

    if (siparis.lines.length === 0) {
      throw ApiException.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Kalemi olmayan siparişten belge kesilemez.',
      );
    }

    /* Belge turu ALICININ MUKELLEFLIGINE gore belirlenir. e-Fatura mukellefi
       olan bir aliciya e-Arsiv faturasi kesmek, faturayi GIB nezdinde gecersiz
       kilar; tersi de dogrudur. Cagiran taraf tur verebilir ama vermezse
       karar veri uzerinden alinir - operatorun her seferinde hatirlamasi
       gereken bir secim, er gec yanlis yapilir. */
    const kind: Kind =
      request.kind ??
      (siparis.company.isEInvoiceUser ? EDocumentKind.EINVOICE : EDocumentKind.EARCHIVE);

    /* Ayni siparisten ikinci bir fatura, ayni mali iki kez faturalamaktir.
       IPTAL EDILMIS belge bu kontrole girmez: iptal sonrasi yeniden kesmek
       mesru bir ihtiyactir. */
    const mevcut = await this.prisma.eDocument.findFirst({
      where: {
        orderId: siparis.id,
        kind,
        status: { not: DbStatus.CANCELLED },
      },
      select: { documentNumber: true },
    });

    if (mevcut) {
      throw ApiException.conflict(
        ErrorCode.CONFLICT,
        `Bu siparişten zaten belge kesilmiş: ${mevcut.documentNumber}.`,
      );
    }

    const satici = this.saticiTarafi();
    const alici = this.aliciTarafi(siparis.company);

    const kesimAni = new Date();

    const { belgeId, uyarilar } = await this.prisma.$transaction(async (tx) => {
      const documentNumber = await this.sonrakiNumara(tx, principal.tenantId, kesimAni);
      const uuid = randomUUID();

      const girdi: UblDocumentInput = {
        kind,
        documentNumber,
        uuid,
        issuedAt: kesimAni,
        currency: siparis.currency,
        supplier: satici,
        customer: alici,
        orderNumber: siparis.orderNumber,
        orderDate: siparis.createdAt,
        note: request.note ?? siparis.customerNote,
        expectedGrandTotal: siparis.grandTotal.toNumber(),
        lines: siparis.lines.map((satir) => ({
          lineNumber: satir.lineNumber,
          productCode: satir.productCode,
          productName: satir.productName,
          unitCode: satir.unitCode,
          quantity: satir.quantity.toNumber(),
          unitPrice: satir.unitPrice.toNumber(),
          grossAmount: satir.grossAmount.toNumber(),
          discountTotal: satir.discountTotal.toNumber(),
          netAmount: satir.netAmount.toNumber(),
          vatRate: satir.vatRate.toNumber(),
          vatAmount: satir.vatAmount.toNumber(),
          note: satir.note,
        })),
      };

      /* Uretici gecersiz belgede ISTISNA ATAR ve islem geri alinir; numara
         tuketilmemis olur. Gecersiz belgeyi entegratore gonderip reddini
         beklemek, o numarayi defterde iptal edilmis bir satir olarak
         birakirdi. */
      const uretim =
        kind === EDocumentKind.EDESPATCH ? buildDespatchAdviceXml(girdi) : buildInvoiceXml(girdi);

      const yol = this.arsivYolu(principal.tenantId, kesimAni, documentNumber);
      const dosya = await this.storage.write(yol, uretim.xml);

      const belge = await tx.eDocument.create({
        data: {
          tenantId: principal.tenantId,
          companyId: siparis.companyId,
          kind,
          status: DbStatus.DRAFT,
          documentNumber,
          uuid,
          issueDate: new Date(kesimAni.toISOString().slice(0, 10)),
          netAmount: new Prisma.Decimal(uretim.totals.taxExclusiveAmount),
          vatAmount: new Prisma.Decimal(uretim.totals.taxAmount),
          grandTotal: new Prisma.Decimal(uretim.totals.taxInclusiveAmount),
          currency: siparis.currency,
          orderId: siparis.id,
          despatchDate: kind === EDocumentKind.EDESPATCH ? kesimAni : null,
          xmlPath: yol,
          contentHash: dosya.hash,
          sizeBytes: dosya.sizeBytes,
        },
        select: { id: true, documentNumber: true },
      });

      return { belgeId: belge.id, uyarilar: uretim.warnings };
    });

    /* Denetim kaydi islem DISINDA yazilir: kesim tamamlandi ve belge dogdu.
       Kaydi isleme baglamak, log yazimindaki bir hatanin kesilmis bir
       faturayi geri almasi demek olurdu - oysa dosya arsivde durmaktadir. */
    await this.audit.recordSafely({
      tenantId: principal.tenantId,
      action: AuditAction.EDOCUMENT_ISSUED,
      resourceType: 'EDocument',
      resourceId: belgeId,
      companyId: siparis.companyId,
      payload: { orderId: siparis.id, kind, warnings: uyarilar },
    });

    if (uyarilar.length > 0) {
      this.logger.warn(`Belge uyarılarla kesildi (${belgeId}): ${uyarilar.join(' · ')}`);
    }

    return {
      document: await this.einvoice.view(principal, belgeId),
      warnings: uyarilar,
    };
  }

  // -------------------------------------------------------------------------
  // Yardimcilar
  // -------------------------------------------------------------------------

  /**
   * Sonraki belge numarasi: SSS + YYYY + 9 hane.
   *
   * Numara BOSLUKSUZ artar; bosluk "silinmis fatura var mi" sorusunu dogurur
   * ve vergi denetiminde aciklanmasi gereken bir anomalidir. Es zamanlilik
   * `pg_advisory_xact_lock` ile kiraci ve yil bazinda seri hale getirilir;
   * kilit islem sonunda kendiliginden birakilir.
   */
  private async sonrakiNumara(
    tx: Prisma.TransactionClient,
    tenantId: string,
    at: Date,
  ): Promise<string> {
    const yil = at.getFullYear();
    const onEk = `${this.config.EINVOICE_SERIES_PREFIX}${yil}`;

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:e-document-number`}))`;

    const son = await tx.eDocument.findFirst({
      where: { tenantId, documentNumber: { startsWith: onEk } },
      orderBy: { documentNumber: 'desc' },
      select: { documentNumber: true },
    });

    const sonSira = son ? Number.parseInt(son.documentNumber.slice(onEk.length), 10) : 0;
    const sonraki = Number.isFinite(sonSira) ? sonSira + 1 : 1;

    return `${onEk}${String(sonraki).padStart(SEQUENCE_WIDTH, '0')}`;
  }

  /**
   * Arsiv yolu: kiraci / yil / ay / numara.
   *
   * Tek dizine on yillik belge koymak, dosya sistemini listeleme yapilamaz
   * hale getirir ve yedekleme araclarini yavaslatir.
   */
  private arsivYolu(tenantId: string, at: Date, documentNumber: string): string {
    const yil = at.getUTCFullYear();
    const ay = String(at.getUTCMonth() + 1).padStart(2, '0');

    return `${tenantId}/${yil}/${ay}/${documentNumber}.xml`;
  }

  private saticiTarafi(): UblParty {
    if (!this.config.EINVOICE_SENDER_TAX_NUMBER || !this.config.EINVOICE_SENDER_TITLE) {
      throw ApiException.serviceUnavailable(
        ErrorCode.EDOCUMENT_NOT_CONFIGURED,
        'e-Belge yapılandırması eksik; belge kesilemez.',
      );
    }

    return {
      taxNumber: this.config.EINVOICE_SENDER_TAX_NUMBER,
      title: this.config.EINVOICE_SENDER_TITLE,
      taxOffice: this.config.EINVOICE_SENDER_TAX_OFFICE ?? null,
      address: this.config.EINVOICE_SENDER_ADDRESS ?? null,
      city: this.config.EINVOICE_SENDER_CITY ?? null,
      district: this.config.EINVOICE_SENDER_DISTRICT ?? null,
    };
  }

  private aliciTarafi(company: {
    title: string;
    taxNumber: string | null;
    taxOffice: string | null;
    address: string | null;
    city: string | null;
    district: string | null;
    email: string | null;
    phone: string | null;
  }): UblParty {
    if (!company.taxNumber) {
      /* Vergi numarasi olmayan cari icin belge KESILMEZ. Entegrator zaten
         reddederdi; farki, redde kadar tuketilmis bir numara olmasidir. */
      throw ApiException.badRequest(
        ErrorCode.VALIDATION_FAILED,
        `${company.title} için VKN/TCKN tanımlı değil; belge kesilemez.`,
      );
    }

    return {
      taxNumber: company.taxNumber,
      title: company.title,
      taxOffice: company.taxOffice,
      address: company.address,
      city: company.city,
      district: company.district,
      email: company.email,
      phone: company.phone,
    };
  }
}
