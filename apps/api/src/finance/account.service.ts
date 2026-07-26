/**
 * ToptanPortal - Cari Hesap Servisi
 *
 * Bakiye ve yaslandirma DAIMA hareketlerden yeniden hesaplanir; `companies`
 * tablosundaki `cached*` alanlari otorite DEGILDIR, yalnizca siparis anindaki
 * risk kalkaninin hizli okumasi icin tutulan onbellektir. Her hesaplamada bu
 * onbellek tazelenir - boylece ekstreyi acan kullanicinin gordugu rakam ile
 * siparis kalkaninin kullandigi rakam ayrisamaz.
 *
 * Ekstrenin yuruyen bakiyesi SQL pencere fonksiyonu ile uretilir. Uygulamada
 * toplamak sayfalama ile bagdasmaz: ikinci sayfanin ilk satiri, kendisinden
 * onceki tum hareketlerin toplamini bilmek zorundadir.
 */

import { Injectable } from '@nestjs/common';
import { AccountEntryKind, Prisma, type PrismaTransactionClient } from '@toptanportal/db';
import {
  ACCOUNT_ENTRY_KIND_LABELS,
  AuditAction,
  ErrorCode,
  type AccountEntry as AccountEntryView,
  type AccountSummary,
  type AgingReport,
  type StatementPage,
  type StatementQuery,
} from '@toptanportal/contracts';

import { AuditService } from '../common/audit/audit.service';
import { ApiException } from '../common/exceptions/api.exception';
import { PrismaService } from '../common/prisma/prisma.service';
import { CompanyScopeService } from '../common/context/company-scope.service';
import type { AuthenticatedPrincipal } from '../common/context/request-context';
import { Decimal, money } from '../pricing/pricing.types';
import { buildAging, overdueDays, type OpenDocument } from './account-math';

/** Tarih araligi verilmeyen ekstre sorgusunun varsayilan penceresi. */
const DEFAULT_STATEMENT_DAYS = 90;

interface StatementRow {
  id: string;
  kind: AccountEntryKind;
  entryDate: Date;
  dueDate: Date | null;
  documentNumber: string;
  description: string | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  openAmount: Prisma.Decimal;
  currency: string;
  orderId: string | null;
  running: Prisma.Decimal;
}

export interface RiskSnapshot {
  balance: Decimal;
  overdueAmount: Decimal;
  overdueDays: number;
  openInvoiceCount: number;
  openDocuments: OpenDocument[];
}

@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: CompanyScopeService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Bakiye ozeti
  // -------------------------------------------------------------------------

  async getSummary(
    principal: AuthenticatedPrincipal,
    requestedCompanyId?: string,
  ): Promise<AccountSummary> {
    const companyId = await this.scope.resolve(principal, requestedCompanyId);
    const company = await this.loadCompany(companyId);
    const risk = await this.computeRisk(companyId);

    await this.persistRiskCache(companyId, risk);

    const lastPayment = await this.prisma.accountEntry.findFirst({
      where: { companyId, kind: AccountEntryKind.PAYMENT },
      orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }],
      select: { entryDate: true, credit: true },
    });

    const creditLimit = new Decimal(company.creditLimit);

    // Ozet ekrani panelde her aciliste okunur; denetim kaydinin yazilamamasi
    // bakiyenin gosterilmesini engellemez. Belge ifsasi sayilan ekstre
    // goruntulemede (asagida) bu tolerans YOKTUR.
    await this.audit.recordSafely({
      tenantId: principal.tenantId,
      action: AuditAction.BALANCE_VIEWED,
      resourceType: 'Company',
      resourceId: companyId,
      companyId,
      payload: {
        balance: risk.balance.toString(),
        overdueAmount: risk.overdueAmount.toString(),
      },
    });

    return {
      companyId,
      companyTitle: company.title,
      currency: 'TRY',
      balance: risk.balance.toNumber(),
      overdueAmount: risk.overdueAmount.toNumber(),
      overdueDays: risk.overdueDays,
      creditLimit: creditLimit.toNumber(),
      availableCredit: creditLimit.greaterThan(0)
        ? money(creditLimit.minus(risk.balance)).toNumber()
        : null,
      paymentTermDays: company.paymentTermDays,
      isBlocked: company.isBlocked,
      blockReason: company.blockReason,
      canOrder:
        company.isActive &&
        !company.isBlocked &&
        risk.overdueAmount.lessThanOrEqualTo(0) &&
        (creditLimit.lessThanOrEqualTo(0) || risk.balance.lessThan(creditLimit)),
      openInvoiceCount: risk.openInvoiceCount,
      lastPaymentAt: lastPayment?.entryDate.toISOString() ?? null,
      lastPaymentAmount: lastPayment ? new Decimal(lastPayment.credit).toNumber() : null,
      calculatedAt: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Ekstre
  // -------------------------------------------------------------------------

  async getStatement(
    principal: AuthenticatedPrincipal,
    query: StatementQuery,
  ): Promise<StatementPage> {
    const companyId = await this.scope.resolve(principal, query.companyId);
    const company = await this.loadCompany(companyId);

    const to = query.to ? parseDate(query.to) : todayUtc();
    const from = query.from
      ? parseDate(query.from)
      : new Date(to.getTime() - DEFAULT_STATEMENT_DAYS * 86_400_000);

    if (from > to) {
      throw ApiException.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Başlangıç tarihi bitiş tarihinden sonra olamaz.',
      );
    }

    const openingBalance = await this.balanceBefore(companyId, from);

    const where: Prisma.AccountEntryWhereInput = {
      companyId,
      entryDate: { gte: from, lte: to },
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.onlyOpen ? { openAmount: { gt: 0 } } : {}),
    };

    const [totals, totalCount, rows] = await Promise.all([
      this.prisma.accountEntry.aggregate({ where, _sum: { debit: true, credit: true } }),
      this.prisma.accountEntry.count({ where }),
      this.queryStatementRows(companyId, from, to, query),
    ]);

    const today = todayUtc();

    return {
      companyId,
      companyTitle: company.title,
      from: toIsoDate(from),
      to: toIsoDate(to),
      openingBalance: openingBalance.toNumber(),
      closingBalance: money(
        openingBalance
          .plus(totals._sum.debit ?? 0)
          .minus(totals._sum.credit ?? 0),
      ).toNumber(),
      debitTotal: money(new Decimal(totals._sum.debit ?? 0)).toNumber(),
      creditTotal: money(new Decimal(totals._sum.credit ?? 0)).toNumber(),
      currency: 'TRY',
      entries: rows.map((row) => this.toEntryView(row, openingBalance, today)),
      totalCount,
      hasMore: query.offset + rows.length < totalCount,
    };
  }

  /**
   * Ekstre satirlarini yuruyen bakiye ile birlikte okur.
   *
   * Pencere fonksiyonu WHERE'den sonra, OFFSET/LIMIT'ten ONCE hesaplanir; bu
   * yuzden ucuncu sayfanin ilk satiri da donemin basindan beri biriken dogru
   * bakiyeyi tasir. Siralama anahtarina `id` eklenmistir: ayni gun ayni anda
   * olusan iki belge her sorguda ayni sirada gelsin diye.
   */
  private async queryStatementRows(
    companyId: string,
    from: Date,
    to: Date,
    query: StatementQuery,
  ): Promise<StatementRow[]> {
    const filters: Prisma.Sql[] = [
      Prisma.sql`"companyId" = ${companyId}::uuid`,
      Prisma.sql`"entryDate" >= ${from}::date`,
      Prisma.sql`"entryDate" <= ${to}::date`,
    ];

    if (query.kind) {
      filters.push(Prisma.sql`kind = ${query.kind}::"AccountEntryKind"`);
    }

    if (query.onlyOpen) {
      filters.push(Prisma.sql`"openAmount" > 0`);
    }

    return this.prisma.$queryRaw<StatementRow[]>`
      SELECT id,
             kind,
             "entryDate",
             "dueDate",
             "documentNumber",
             description,
             debit,
             credit,
             "openAmount",
             currency,
             "orderId",
             SUM(debit - credit) OVER (
               ORDER BY "entryDate", "createdAt", id
               ROWS UNBOUNDED PRECEDING
             ) AS running
      FROM account_entries
      WHERE ${Prisma.join(filters, ' AND ')}
      ORDER BY "entryDate", "createdAt", id
      OFFSET ${query.offset}
      LIMIT ${query.limit}
    `;
  }

  private toEntryView(row: StatementRow, opening: Decimal, today: Date): AccountEntryView {
    return {
      id: row.id,
      kind: row.kind,
      kindLabel: ACCOUNT_ENTRY_KIND_LABELS[row.kind],
      entryDate: toIsoDate(row.entryDate),
      dueDate: row.dueDate ? toIsoDate(row.dueDate) : null,
      documentNumber: row.documentNumber,
      description: row.description,
      debit: new Decimal(row.debit).toNumber(),
      credit: new Decimal(row.credit).toNumber(),
      openAmount: new Decimal(row.openAmount).toNumber(),
      runningBalance: money(opening.plus(row.running)).toNumber(),
      currency: row.currency,
      overdueDays: new Decimal(row.openAmount).greaterThan(0)
        ? overdueDays(row.dueDate, today)
        : 0,
      orderId: row.orderId,
    };
  }

  // -------------------------------------------------------------------------
  // Yaslandirma
  // -------------------------------------------------------------------------

  async getAging(
    principal: AuthenticatedPrincipal,
    requestedCompanyId?: string,
  ): Promise<AgingReport> {
    const companyId = await this.scope.resolve(principal, requestedCompanyId);
    const company = await this.loadCompany(companyId);
    const documents = await this.openDocuments(companyId);
    const aging = buildAging(documents, todayUtc());

    return {
      companyId,
      companyTitle: company.title,
      currency: 'TRY',
      buckets: aging.buckets.map((bucket) => ({
        key: bucket.key,
        label: bucket.label,
        amount: bucket.amount.toNumber(),
        documentCount: bucket.documentCount,
      })),
      totalOpen: aging.totalOpen.toNumber(),
      totalOverdue: aging.totalOverdue.toNumber(),
      oldestOverdueDays: aging.oldestOverdueDays,
      calculatedAt: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Risk hesabi ve onbellek
  // -------------------------------------------------------------------------

  /** Acik (kapanmamis) belgeler - tahsilat dagitimi ve yaslandirma ortak kullanir. */
  async openDocuments(companyId: string, tx?: PrismaTransactionClient): Promise<OpenDocument[]> {
    const client = tx ?? this.prisma;

    const rows = await client.accountEntry.findMany({
      where: { companyId, openAmount: { gt: 0 } },
      select: { id: true, dueDate: true, entryDate: true, openAmount: true },
      orderBy: [{ dueDate: 'asc' }, { entryDate: 'asc' }],
    });

    return rows.map((row) => ({
      id: row.id,
      dueDate: row.dueDate,
      entryDate: row.entryDate,
      openAmount: new Decimal(row.openAmount),
    }));
  }

  async computeRisk(companyId: string, tx?: PrismaTransactionClient): Promise<RiskSnapshot> {
    const client = tx ?? this.prisma;

    const [totals, documents] = await Promise.all([
      client.accountEntry.aggregate({
        where: { companyId },
        _sum: { debit: true, credit: true },
      }),
      this.openDocuments(companyId, tx),
    ]);

    const aging = buildAging(documents, todayUtc());

    return {
      balance: money(
        new Decimal(totals._sum.debit ?? 0).minus(totals._sum.credit ?? 0),
      ),
      overdueAmount: aging.totalOverdue,
      overdueDays: aging.oldestOverdueDays,
      openInvoiceCount: documents.length,
      openDocuments: documents,
    };
  }

  /**
   * Siparis risk kalkaninin okudugu onbellegi tazeler.
   * Tahsilat sonrasi cagrilmasi kritiktir: borcunu odeyen bayinin siparisi
   * bir sonraki senkronizasyona kadar bloke kalmamalidir.
   */
  async persistRiskCache(
    companyId: string,
    risk: RiskSnapshot,
    tx?: PrismaTransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma;

    await client.company.update({
      where: { id: companyId },
      data: {
        cachedBalance: risk.balance,
        cachedOverdueAmount: risk.overdueAmount,
        cachedOverdueDays: risk.overdueDays,
        riskDataSyncedAt: new Date(),
      },
    });
  }

  async refreshRiskCache(companyId: string, tx?: PrismaTransactionClient): Promise<RiskSnapshot> {
    const risk = await this.computeRisk(companyId, tx);
    await this.persistRiskCache(companyId, risk, tx);
    return risk;
  }

  // -------------------------------------------------------------------------
  // Yardimcilar
  // -------------------------------------------------------------------------

  private async balanceBefore(companyId: string, from: Date): Promise<Decimal> {
    const totals = await this.prisma.accountEntry.aggregate({
      where: { companyId, entryDate: { lt: from } },
      _sum: { debit: true, credit: true },
    });

    return money(new Decimal(totals._sum.debit ?? 0).minus(totals._sum.credit ?? 0));
  }

  private async loadCompany(companyId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        id: true,
        title: true,
        isActive: true,
        isBlocked: true,
        blockReason: true,
        creditLimit: true,
        paymentTermDays: true,
      },
    });

    if (!company) {
      throw ApiException.notFound(ErrorCode.RESOURCE_NOT_FOUND, 'İşletme bulunamadı.');
    }

    return company;
  }
}

/** `YYYY-AA-GG` metnini UTC gun basina cevirir - `@db.Date` alanlariyla ayni taban. */
export function parseDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
