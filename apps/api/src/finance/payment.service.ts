/**
 * ToptanPortal - Tahsilat Servisi
 *
 * Tahsilat, portalda dogan tek cari hareket tipidir; digerleri Logo'dan aynalanir.
 *
 * ONAY MODELI: kredi karti ve DBS tahsilati saglayicidan donus aldigi icin
 * dogrudan CONFIRMED dogar. Nakit, cek ve senet FIZIKSEL teslim gerektirir;
 * bunlar PENDING dogar ve toptanci tarafinda (COMPANY_MANAGE yetkisi) elden
 * dogrulanir. Kaydi giren kisinin kendi kaydini onaylamasi mumkun degildir -
 * saha tahsilatinda gorevler ayriligi budur.
 *
 * Cari hareket YALNIZCA onay aninda yazilir: onaylanmamis bir tahsilat bakiyeyi
 * dusurmez, dolayisiyla risk kalkanini da acmaz.
 */

import { Injectable } from '@nestjs/common';
import {
  AccountEntryKind,
  PaymentStatus as PaymentStatusEnum,
  Prisma,
  UserStatus,
  type PrismaTransactionClient,
} from '@toptanportal/db';
import {
  AuditAction,
  ErrorCode,
  NotificationTopic,
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  Permission,
  SELF_CONFIRMING_METHODS,
  roleHasPermission,
  type PaymentListQuery,
  type PaymentPage,
  type PaymentView,
  type RecordPaymentRequest,
} from '@toptanportal/contracts';

import { AuditService } from '../common/audit/audit.service';
import { ApiException } from '../common/exceptions/api.exception';
import { PrismaService } from '../common/prisma/prisma.service';
import { CompanyScopeService } from '../common/context/company-scope.service';
import { NotificationService } from '../notification/notification.service';
import type { AuthenticatedPrincipal } from '../common/context/request-context';
import { Decimal, money } from '../pricing/pricing.types';
import { AccountService, parseDate, todayUtc, toIsoDate } from './account.service';
import { allocateFifo, type Allocation } from './account-math';

export const PAYMENT_INCLUDE = {
  company: { select: { title: true } },
  recordedBy: { select: { fullName: true } },
  allocations: {
    orderBy: { createdAt: 'asc' },
    select: {
      entryId: true,
      amount: true,
      entry: { select: { documentNumber: true, entryDate: true } },
    },
  },
} satisfies Prisma.PaymentInclude;

export type PaymentRow = Prisma.PaymentGetPayload<{ include: typeof PAYMENT_INCLUDE }>;

@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: CompanyScopeService,
    private readonly account: AccountService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  // -------------------------------------------------------------------------
  // Kayit
  // -------------------------------------------------------------------------

  async record(
    principal: AuthenticatedPrincipal,
    request: RecordPaymentRequest,
  ): Promise<PaymentView> {
    const companyId = await this.scope.resolve(principal, request.companyId);
    const amount = money(new Decimal(request.amount));
    const isFieldCollection =
      roleHasPermission(principal.role, Permission.COLLECTION_RECORD) &&
      !roleHasPermission(principal.role, Permission.PAYMENT_CREATE);

    // Saha tahsilatinda nakit disi yontemler plasiyerin elinde dogrulanamaz.
    if (isFieldCollection && SELF_CONFIRMING_METHODS.includes(request.method)) {
      throw ApiException.unprocessable(
        ErrorCode.VALIDATION_FAILED,
        'Saha tahsilatı kredi kartı veya DBS ile kaydedilemez.',
      );
    }

    const selfConfirming = SELF_CONFIRMING_METHODS.includes(request.method);
    const receivedAt = request.receivedAt ? new Date(request.receivedAt) : new Date();

    const payment = await this.prisma.$transaction(
      async (tx) => {
        const created = await tx.payment.create({
          data: {
            tenantId: principal.tenantId,
            companyId,
            method: request.method,
            status: selfConfirming ? PaymentStatusEnum.CONFIRMED : PaymentStatusEnum.PENDING,
            amount,
            receivedAt,
            reference: request.reference ?? null,
            note: request.note ?? null,
            recordedByUserId: principal.userId,
            isFieldCollection,
          },
          include: PAYMENT_INCLUDE,
        });

        await this.audit.record(
          {
            tenantId: principal.tenantId,
            action: AuditAction.PAYMENT_INITIATED,
            resourceType: 'Payment',
            resourceId: created.id,
            companyId,
            payload: {
              amount: amount.toString(),
              method: request.method,
              reference: request.reference ?? null,
              isFieldCollection,
            },
          },
          tx,
        );

        if (!selfConfirming) {
          return created;
        }

        return this.settle(tx, created, request.allocations);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20000 },
    );

    return this.toView(payment);
  }

  // -------------------------------------------------------------------------
  // Onay / iptal
  // -------------------------------------------------------------------------

  async confirm(principal: AuthenticatedPrincipal, paymentId: string): Promise<PaymentView> {
    const existing = await this.loadInScope(principal, paymentId);

    if (existing.status !== PaymentStatusEnum.PENDING) {
      throw ApiException.conflict(
        ErrorCode.CONFLICT,
        'Bu tahsilat kaydı zaten sonuçlandırılmış.',
      );
    }

    if (existing.recordedByUserId === principal.userId) {
      throw ApiException.forbidden(
        ErrorCode.FORBIDDEN,
        'Kendi girdiğiniz tahsilat kaydını onaylayamazsınız.',
      );
    }

    const payment = await this.prisma.$transaction(
      async (tx) => this.settle(tx, existing),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20000 },
    );

    return this.toView(payment);
  }

  async cancel(
    principal: AuthenticatedPrincipal,
    paymentId: string,
    reason: string,
  ): Promise<PaymentView> {
    const existing = await this.loadInScope(principal, paymentId);

    if (existing.status !== PaymentStatusEnum.PENDING) {
      throw ApiException.conflict(
        ErrorCode.CONFLICT,
        'Yalnızca onay bekleyen tahsilat kaydı iptal edilebilir.',
      );
    }

    const payment = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.payment.update({
        where: { id: paymentId },
        data: { status: PaymentStatusEnum.CANCELLED, failureReason: reason },
        include: PAYMENT_INCLUDE,
      });

      await this.audit.record(
        {
          tenantId: principal.tenantId,
          action: AuditAction.PAYMENT_FAILED,
          resourceType: 'Payment',
          resourceId: paymentId,
          companyId: existing.companyId,
          payload: { amount: existing.amount.toString(), reason },
        },
        tx,
      );

      return updated;
    });

    return this.toView(payment);
  }

  /**
   * Tahsilati cari harekete donusturur ve acik belgelere dagitir.
   *
   * Ayni islem icinde: cari hareket, dagitim satirlari, kapatilan belgelerin
   * `openAmount` dusumu, risk onbellegi ve denetim kaydi yazilir. Herhangi biri
   * yazilamazsa tahsilat da onaylanmis sayilmaz.
   */
  /**
   * Sanal POS ve DBS gibi KULLANICISIZ akislar icin tahsilati kapatir.
   *
   * Bankadan donen bir sonucta oturum acmis bir kullanici yoktur; islemi
   * baslatan kisi kaydin uzerinde `recordedByUserId` olarak zaten durur.
   * Ayni kapama mantigini ikinci kez yazmak yerine buradan paylasilir -
   * dagitim ve risk onbellegi kurallari tek yerde kalmalidir.
   */
  async settleExternal(
    tx: PrismaTransactionClient,
    payment: PaymentRow,
    requested?: RecordPaymentRequest['allocations'],
  ): Promise<PaymentRow> {
    return this.settle(tx, payment, requested);
  }

  private async settle(
    tx: PrismaTransactionClient,
    payment: PaymentRow,
    requested?: RecordPaymentRequest['allocations'],
  ): Promise<PaymentRow> {
    const amount = new Decimal(payment.amount);
    const open = await this.account.openDocuments(payment.companyId, tx);

    const allocations = requested?.length
      ? this.validateAllocations(requested, open, amount)
      : allocateFifo(open, amount).allocations;

    const entry = await tx.accountEntry.create({
      data: {
        tenantId: payment.tenantId,
        companyId: payment.companyId,
        kind: AccountEntryKind.PAYMENT,
        entryDate: todayUtc(),
        documentNumber: buildReceiptNumber(payment),
        description: `${PAYMENT_METHOD_LABELS[payment.method]} tahsilatı`,
        credit: amount,
        currency: payment.currency,
      },
    });

    for (const allocation of allocations) {
      await tx.paymentAllocation.create({
        data: { paymentId: payment.id, entryId: allocation.entryId, amount: allocation.amount },
      });

      await tx.accountEntry.update({
        where: { id: allocation.entryId },
        data: { openAmount: { decrement: allocation.amount } },
      });
    }

    const updated = await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatusEnum.CONFIRMED,
        confirmedAt: new Date(),
        entryId: entry.id,
      },
      include: PAYMENT_INCLUDE,
    });

    await this.account.refreshRiskCache(payment.companyId, tx);

    await this.audit.record(
      {
        tenantId: payment.tenantId,
        action: AuditAction.PAYMENT_SUCCEEDED,
        resourceType: 'Payment',
        resourceId: payment.id,
        companyId: payment.companyId,
        payload: {
          amount: amount.toString(),
          method: payment.method,
          entryId: entry.id,
          allocatedDocuments: allocations.length,
        },
      },
      tx,
    );

    await this.tahsilatBildirimi(tx, payment, amount.toNumber(), allocations.length);

    return updated;
  }

  /**
   * Tahsilat bildirimi.
   *
   * Bu bildirim bir TESEKKUR degil, MUTABAKAT araci: bayi parayi gonderdikten
   * sonra "islendi mi?" diye arar ve o arama, tahsilat masasinin en sik
   * yaptigi istir. Bildirim gitmezse telefon calar.
   *
   * Alici, bakiye gormeye yetkili isletme kullanicilaridir - konu parasaldir
   * ve Kor Siparis Modundaki kullaniciya hic uretilmez (bkz.
   * NotificationService.aliciUygunMu).
   */
  private async tahsilatBildirimi(
    tx: PrismaTransactionClient,
    payment: PaymentRow,
    amount: number,
    allocatedDocuments: number,
  ): Promise<void> {
    const alicilar = await tx.user.findMany({
      where: {
        companyId: payment.companyId,
        tenantId: payment.tenantId,
        status: UserStatus.ACTIVE,
        deletedAt: null,
      },
      select: { id: true },
    });

    await this.notifications.enqueue(
      {
        tenantId: payment.tenantId,
        payload: {
          topic: NotificationTopic.PAYMENT_RECEIVED,
          amount,
          currency: payment.currency,
          methodLabel: PAYMENT_METHOD_LABELS[payment.method],
          companyTitle: payment.company?.title ?? '',
          /* Tek belge kapandiysa numarasi yazilir; birkac belge kapandiysa
             hangisinin yazilacagi belirsizdir ve yanlisini yazmak, ekstreyi
             bastan sona kontrol ettirir. */
          documentNumber: allocatedDocuments === 1 ? buildReceiptNumber(payment) : null,
        },
        recipientUserIds: alicilar.map((alici) => alici.id),
        dedupeKey: `payment:${payment.id}:confirmed`,
        relatedType: 'Payment',
        relatedId: payment.id,
      },
      tx,
    );
  }

  /**
   * Istemcinin verdigi dagitimi dogrular.
   * Kapali veya baska cariye ait belgeye dagitim yapilamaz; toplam dagitim
   * tahsilat tutarini asamaz. Eksik dagitim serbesttir - kalan avans olur.
   */
  private validateAllocations(
    requested: NonNullable<RecordPaymentRequest['allocations']>,
    open: readonly { id: string; openAmount: Decimal }[],
    amount: Decimal,
  ): Allocation[] {
    const openById = new Map(open.map((document) => [document.id, document.openAmount]));
    const result: Allocation[] = [];
    let total = new Decimal(0);

    for (const item of requested) {
      const available = openById.get(item.entryId);

      if (!available) {
        throw ApiException.unprocessable(
          ErrorCode.VALIDATION_FAILED,
          'Kapatılmak istenen belge bulunamadı veya zaten kapanmış.',
        );
      }

      const applied = money(new Decimal(item.amount));

      if (applied.greaterThan(available)) {
        throw ApiException.unprocessable(
          ErrorCode.VALIDATION_FAILED,
          'Bir belgeye kalan borcundan fazla tahsilat işlenemez.',
        );
      }

      total = total.plus(applied);
      result.push({ entryId: item.entryId, amount: applied });
    }

    if (total.greaterThan(amount)) {
      throw ApiException.unprocessable(
        ErrorCode.VALIDATION_FAILED,
        'Belgelere dağıtılan tutar tahsilat tutarını aşıyor.',
      );
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Listeleme
  // -------------------------------------------------------------------------

  async list(
    principal: AuthenticatedPrincipal,
    query: PaymentListQuery,
  ): Promise<PaymentPage> {
    const companyFilter = await this.scope.listFilter(principal, query.companyId);

    const where: Prisma.PaymentWhereInput = {
      tenantId: principal.tenantId,
      ...companyFilter,
      ...(query.status ? { status: query.status } : {}),
      ...(query.onlyMine ? { recordedByUserId: principal.userId } : {}),
      ...(query.from || query.to
        ? {
            receivedAt: {
              ...(query.from ? { gte: parseDate(query.from) } : {}),
              ...(query.to ? { lte: endOfDay(parseDate(query.to)) } : {}),
            },
          }
        : {}),
    };

    const [rows, totalCount, totals] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        include: PAYMENT_INCLUDE,
        orderBy: [{ receivedAt: 'desc' }, { createdAt: 'desc' }],
        skip: query.offset,
        take: query.limit,
      }),
      this.prisma.payment.count({ where }),
      this.prisma.payment.aggregate({ where, _sum: { amount: true } }),
    ]);

    return {
      payments: rows.map((row) => this.toView(row)),
      totalCount,
      totalAmount: money(new Decimal(totals._sum.amount ?? 0)).toNumber(),
      hasMore: query.offset + rows.length < totalCount,
    };
  }

  private async loadInScope(
    principal: AuthenticatedPrincipal,
    paymentId: string,
  ): Promise<PaymentRow> {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, tenantId: principal.tenantId },
      include: PAYMENT_INCLUDE,
    });

    if (!payment) {
      throw ApiException.notFound(ErrorCode.RESOURCE_NOT_FOUND, 'Tahsilat kaydı bulunamadı.');
    }

    await this.scope.resolve(principal, payment.companyId);

    return payment;
  }

  private toView(payment: PaymentRow): PaymentView {
    const amount = new Decimal(payment.amount);
    const allocated = payment.allocations.reduce(
      (sum, allocation) => sum.plus(allocation.amount),
      new Decimal(0),
    );

    return {
      id: payment.id,
      companyId: payment.companyId,
      companyTitle: payment.company.title,
      method: payment.method,
      methodLabel: PAYMENT_METHOD_LABELS[payment.method],
      status: payment.status,
      statusLabel: PAYMENT_STATUS_LABELS[payment.status],
      amount: amount.toNumber(),
      currency: payment.currency,
      receivedAt: payment.receivedAt.toISOString(),
      reference: payment.reference,
      note: payment.note,
      recordedByName: payment.recordedBy.fullName,
      isFieldCollection: payment.isFieldCollection,
      confirmedAt: payment.confirmedAt?.toISOString() ?? null,
      allocations: payment.allocations.map((allocation) => ({
        entryId: allocation.entryId,
        documentNumber: allocation.entry.documentNumber,
        entryDate: toIsoDate(allocation.entry.entryDate),
        amount: new Decimal(allocation.amount).toNumber(),
      })),
      unallocatedAmount: money(amount.minus(allocated)).toNumber(),
    };
  }
}

/** Makbuz numarasi: tahsilat kimliginin son sekiz hanesi yeterince ayirt edicidir. */
function buildReceiptNumber(payment: { id: string; receivedAt: Date }): string {
  return `TAH-${toIsoDate(payment.receivedAt).replace(/-/g, '')}-${payment.id
    .replace(/-/g, '')
    .slice(-8)
    .toUpperCase()}`;
}

function endOfDay(date: Date): Date {
  return new Date(date.getTime() + 86_399_999);
}
