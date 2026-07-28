/**
 * ToptanPortal API - DBS (Dogrudan Borclandirma Sistemi)
 *
 * Akis dosya tabanlidir ve iki yonlu calisir:
 *   1. Toptanci, vadesi gelen acik belgeleri BORC DOSYASI olarak bankaya verir.
 *   2. Banka gun sonunda SONUC DOSYASI doner: hangi belge tahsil edildi,
 *      hangisi edilemedi.
 *
 * TUTARLAR KURUS (minor unit) OLARAK YAZILIR. Ondalik ayraci bankadan bankaya
 * degisir (virgul, nokta, hic yok) ve yanlis yorumlanan bir ayrac 1.234,56 TL'yi
 * 123.456 TL yapar. Tamsayi kurus bu belirsizligi tamamen ortadan kaldirir.
 *
 * AYNI BELGE IKI KEZ DOSYAYA GIREMEZ. Veritabanindaki kismi benzersiz indeks
 * bunu garanti eder; uygulama katmani da once kontrol eder ama son soz
 * veritabanindadir - iki es zamanli disa aktarim, uygulama kontrolunu birlikte
 * gecebilir.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  DbsFileKind,
  DbsRecordStatus,
  PaymentMethod as PaymentMethodEnum,
  PaymentStatus as PaymentStatusEnum,
  Prisma,
} from '@toptanportal/db';
import {
  AuditAction,
  DBS_RECORD_STATUS_LABELS,
  ErrorCode,
  type DbsBatchView,
  type DbsExportQuery,
  type DbsImportRequest,
  type DbsImportResult,
  type DbsRecordView,
} from '@toptanportal/contracts';

import { AuditService } from '../common/audit/audit.service';
import { ApiException } from '../common/exceptions/api.exception';
import { PaymentService, PAYMENT_INCLUDE } from '../finance/payment.service';
import { PrismaService } from '../common/prisma/prisma.service';
import type { AuthenticatedPrincipal } from '../common/context/request-context';

/** Bir dosyada tasinabilecek azami kayit. Banka sistemleri sinirsiz kabul etmez. */
const AZAMI_KAYIT = 5000;

export interface DbsExportResult {
  batch: DbsBatchView;
  records: DbsRecordView[];
  /** Bankaya yuklenecek dosya icerigi. */
  content: string;
  fileName: string;
}

@Injectable()
export class DbsService {
  private readonly logger = new Logger(DbsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Borc dosyasi
  // -------------------------------------------------------------------------

  async exportDebts(
    principal: AuthenticatedPrincipal,
    query: DbsExportQuery,
  ): Promise<DbsExportResult> {
    const dueUntil = new Date(`${query.dueUntil}T23:59:59.999Z`);

    const belgeler = await this.prisma.accountEntry.findMany({
      where: {
        tenantId: principal.tenantId,
        openAmount: { gt: 0 },
        dueDate: { not: null, lte: dueUntil },
        ...(query.companyIds?.length ? { companyId: { in: query.companyIds } } : {}),
        /* Halihazirda bankada bekleyen belge tekrar gonderilmez. */
        dbsRecords: { none: { status: DbsRecordStatus.PENDING } },
      },
      include: { company: { select: { id: true, title: true, logoCariCode: true } } },
      orderBy: [{ dueDate: 'asc' }, { documentNumber: 'asc' }],
      take: AZAMI_KAYIT,
    });

    if (belgeler.length === 0) {
      throw ApiException.unprocessable(
        ErrorCode.VALIDATION_FAILED,
        'Bu ölçütlere uyan, bankaya bildirilmemiş açık belge bulunmuyor.',
      );
    }

    const fileName = `dbs-${query.bankCode}-${query.dueUntil}-${Date.now()}.txt`;
    const toplam = belgeler.reduce(
      (toplam, belge) => toplam.plus(belge.openAmount),
      new Prisma.Decimal(0),
    );

    const parti = await this.prisma.$transaction(async (tx) => {
      const olusan = await tx.dbsBatch.create({
        data: {
          tenantId: principal.tenantId,
          bankCode: query.bankCode,
          kind: DbsFileKind.DEBT,
          fileName,
          recordCount: belgeler.length,
          totalAmount: toplam,
          createdByUserId: principal.userId,
        },
        include: { createdBy: { select: { fullName: true } } },
      });

      await tx.dbsRecord.createMany({
        data: belgeler.map((belge) => ({
          batchId: olusan.id,
          companyId: belge.companyId,
          entryId: belge.id,
          amount: belge.openAmount,
          dueDate: belge.dueDate as Date,
        })),
      });

      await this.audit.record(
        {
          tenantId: principal.tenantId,
          action: AuditAction.PAYMENT_INITIATED,
          resourceType: 'DbsBatch',
          resourceId: olusan.id,
          payload: {
            bankCode: query.bankCode,
            recordCount: belgeler.length,
            totalAmount: toplam.toString(),
          },
        },
        tx,
      );

      return olusan;
    });

    const kayitlar = await this.prisma.dbsRecord.findMany({
      where: { batchId: parti.id },
      include: {
        company: { select: { title: true, logoCariCode: true } },
        entry: { select: { documentNumber: true, currency: true } },
      },
      orderBy: { dueDate: 'asc' },
    });

    const satirlar = kayitlar.map((kayit) =>
      [
        kayit.company.logoCariCode,
        kayit.entry.documentNumber,
        formatDate(kayit.dueDate),
        toKurus(kayit.amount),
        kayit.entry.currency,
      ].join(';'),
    );

    return {
      batch: {
        id: parti.id,
        bankCode: parti.bankCode,
        kind: DbsFileKind.DEBT,
        fileName: parti.fileName,
        recordCount: parti.recordCount,
        totalAmount: parti.totalAmount.toNumber(),
        currency: parti.currency,
        createdByName: parti.createdBy.fullName,
        createdAt: parti.createdAt.toISOString(),
        processedAt: null,
        collectedCount: 0,
        rejectedCount: 0,
      },
      records: kayitlar.map((kayit) => ({
        id: kayit.id,
        companyId: kayit.companyId,
        companyTitle: kayit.company.title,
        entryId: kayit.entryId,
        documentNumber: kayit.entry.documentNumber,
        dueDate: kayit.dueDate.toISOString(),
        amount: kayit.amount.toNumber(),
        currency: kayit.entry.currency,
        status: kayit.status,
        statusLabel: DBS_RECORD_STATUS_LABELS[kayit.status],
        rejectReason: kayit.rejectReason,
      })),
      content: `${satirlar.join('\r\n')}\r\n`,
      fileName,
    };
  }

  // -------------------------------------------------------------------------
  // Sonuc dosyasi
  // -------------------------------------------------------------------------

  /**
   * Banka sonuc dosyasini isler.
   *
   * Beklenen satir bicimi:
   *   `cariKod;belgeNo;sonuc(1|0);tahsilTarihi(YYYYAAGG);tutarKurus;redSebebi`
   *
   * ESLESMEYEN SATIR ATLANMAZ, RAPORLANIR. Bankanin bildirdigi ama portalde
   * karsiligi bulunmayan bir tahsilat, sessizce yok sayilirsa bayi parayi
   * odemis ama borcu acik kalmis olur; bunu ancak bayi telefon ettiginde
   * ogrenirsiniz.
   */
  async importResults(
    principal: AuthenticatedPrincipal,
    request: DbsImportRequest,
  ): Promise<DbsImportResult> {
    const satirlar = request.content
      .split(/\r?\n/)
      .map((satir) => satir.trim())
      .filter((satir) => satir.length > 0);

    if (satirlar.length === 0) {
      throw ApiException.unprocessable(ErrorCode.VALIDATION_FAILED, 'Dosya boş.');
    }

    const parti = await this.prisma.dbsBatch.create({
      data: {
        tenantId: principal.tenantId,
        bankCode: request.bankCode,
        kind: DbsFileKind.RESULT,
        fileName: request.fileName,
        recordCount: satirlar.length,
        createdByUserId: principal.userId,
        processedAt: new Date(),
      },
    });

    const eslesmeyen: string[] = [];
    let tahsilEdilen = 0;
    let reddedilen = 0;
    let tahsilTutari = new Prisma.Decimal(0);

    for (const satir of satirlar) {
      const alanlar = satir.split(';');

      if (alanlar.length < 3) {
        eslesmeyen.push(satir.slice(0, 200));
        continue;
      }

      const cariKod = (alanlar[0] ?? '').trim();
      const belgeNo = (alanlar[1] ?? '').trim();
      const sonuc = (alanlar[2] ?? '').trim();
      const redSebebi = alanlar[5]?.trim() || null;

      if (cariKod.length === 0 || belgeNo.length === 0) {
        eslesmeyen.push(satir.slice(0, 200));
        continue;
      }

      const kayit = await this.prisma.dbsRecord.findFirst({
        where: {
          status: DbsRecordStatus.PENDING,
          company: { tenantId: principal.tenantId, logoCariCode: cariKod },
          entry: { documentNumber: belgeNo },
        },
        include: { entry: { select: { currency: true } } },
      });

      if (!kayit) {
        eslesmeyen.push(satir.slice(0, 200));
        continue;
      }

      if (sonuc === '1') {
        await this.collect(kayit.id, principal, parti.id);
        tahsilEdilen += 1;
        tahsilTutari = tahsilTutari.plus(kayit.amount);
      } else {
        await this.prisma.dbsRecord.update({
          where: { id: kayit.id },
          data: {
            status: DbsRecordStatus.REJECTED,
            rejectReason: redSebebi?.slice(0, 280) ?? 'Banka tahsil edemedi.',
          },
        });
        reddedilen += 1;
      }
    }

    await this.prisma.dbsBatch.update({
      where: { id: parti.id },
      data: { totalAmount: tahsilTutari },
    });

    if (eslesmeyen.length > 0) {
      this.logger.warn(
        `DBS sonuç dosyasında ${eslesmeyen.length} satırın portalde karşılığı bulunamadı.`,
      );
    }

    await this.audit.recordSafely({
      tenantId: principal.tenantId,
      action: AuditAction.PAYMENT_SUCCEEDED,
      resourceType: 'DbsBatch',
      resourceId: parti.id,
      payload: {
        bankCode: request.bankCode,
        collectedCount: tahsilEdilen,
        rejectedCount: reddedilen,
        unmatchedCount: eslesmeyen.length,
        collectedAmount: tahsilTutari.toString(),
      },
    });

    return {
      batchId: parti.id,
      collectedCount: tahsilEdilen,
      collectedAmount: tahsilTutari.toNumber(),
      rejectedCount: reddedilen,
      unmatchedLines: eslesmeyen.slice(0, 200),
    };
  }

  /**
   * Tahsil edilen kaydin tahsilatini yazar.
   *
   * Dagitim ACIKCA belirtilir: DBS'te hangi belgenin tahsil edildigi bellidir,
   * FIFO dagitimina birakmak yanlis belgeyi kapatirdi.
   */
  private async collect(
    recordId: string,
    principal: AuthenticatedPrincipal,
    resultBatchId: string,
  ): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        const kayit = await tx.dbsRecord.findUniqueOrThrow({
          where: { id: recordId },
          include: { entry: { select: { currency: true } } },
        });

        const payment = await tx.payment.create({
          data: {
            tenantId: principal.tenantId,
            companyId: kayit.companyId,
            method: PaymentMethodEnum.DBS,
            status: PaymentStatusEnum.PENDING,
            amount: kayit.amount,
            currency: kayit.entry.currency,
            receivedAt: new Date(),
            reference: `DBS-${resultBatchId.slice(0, 8)}`,
            recordedByUserId: principal.userId,
          },
          include: PAYMENT_INCLUDE,
        });

        await this.payments.settleExternal(tx, payment, [
          { entryId: kayit.entryId, amount: kayit.amount.toNumber() },
        ]);

        await tx.dbsRecord.update({
          where: { id: kayit.id },
          data: {
            status: DbsRecordStatus.COLLECTED,
            collectedAt: new Date(),
            paymentId: payment.id,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20000 },
    );
  }

  async listBatches(principal: AuthenticatedPrincipal): Promise<DbsBatchView[]> {
    const partiler = await this.prisma.dbsBatch.findMany({
      where: { tenantId: principal.tenantId },
      include: {
        createdBy: { select: { fullName: true } },
        records: { select: { status: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return partiler.map((parti) => ({
      id: parti.id,
      bankCode: parti.bankCode,
      kind: parti.kind,
      fileName: parti.fileName,
      recordCount: parti.recordCount,
      totalAmount: parti.totalAmount.toNumber(),
      currency: parti.currency,
      createdByName: parti.createdBy.fullName,
      createdAt: parti.createdAt.toISOString(),
      processedAt: parti.processedAt?.toISOString() ?? null,
      collectedCount: parti.records.filter((k) => k.status === DbsRecordStatus.COLLECTED).length,
      rejectedCount: parti.records.filter((k) => k.status === DbsRecordStatus.REJECTED).length,
    }));
  }
}

/** `2026-08-01` -> `20260801` */
function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10).replace(/-/g, '');
}

/** `1234.56` -> `123456`. Ondalik ayraci belirsizligini ortadan kaldirir. */
function toKurus(value: Prisma.Decimal): string {
  return value.mul(100).toDecimalPlaces(0).toFixed(0);
}
