/**
 * ToptanPortal API - Bayi Portfoyu
 *
 * Plasiyerin gunune baktigi ekranin verisi. Uc soruyu cevaplar:
 * kim borclu, kim uzun suredir siparis vermedi, kimi ne zaman ziyaret ettim.
 *
 * KAPSAM SUNUCUDA CIZILIR. `listFilter` plasiyerin atanmis bayilerini doner ve
 * istemcinin gonderdigi suzgecler bunun UZERINE eklenir - hicbir parametre
 * kapsami genisletemez. Bir plasiyerin baska bir plasiyerin bayisini gormesi,
 * musteri listesinin el degistirmesi demektir.
 *
 * PARASAL ALANLAR yetkisiz rolde HIC SORGULANMAZ; yanit suzgecine
 * birakilmaz. Bkz. `blind-order.ts` - suzgec son savunma hattidir, birinci
 * degil.
 */

import { Injectable } from '@nestjs/common';
import { OrderStatus, Prisma } from '@toptanportal/db';
import {
  Permission,
  roleHasPermission,
  type CompanyListItem,
  type CompanyListQuery,
  type CompanyPage,
} from '@toptanportal/contracts';

import { CompanyScopeService } from '../common/context/company-scope.service';
import { PrismaService } from '../common/prisma/prisma.service';
import type { AuthenticatedPrincipal } from '../common/context/request-context';

/** Ciroya sayilan siparis durumlari - iptal ve ret disaridadir. */
const CIRO_DURUMLARI = [OrderStatus.CONFIRMED, OrderStatus.QUEUED, OrderStatus.SENDING];

@Injectable()
export class PortfolioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: CompanyScopeService,
  ) {}

  async list(
    principal: AuthenticatedPrincipal,
    query: CompanyListQuery,
  ): Promise<CompanyPage> {
    const kapsam = await this.scope.listFilter(principal);
    const bakiyeGorebilir = roleHasPermission(principal.role, Permission.BALANCE_VIEW);

    const where: Prisma.CompanyWhereInput = {
      tenantId: principal.tenantId,
      ...(kapsam ?? {}),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' } },
              { logoCariCode: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(query.city ? { city: { equals: query.city, mode: 'insensitive' } } : {}),
      ...(query.onlyOverdue ? { cachedOverdueAmount: { gt: 0 } } : {}),
    };

    const [bayiler, toplam] = await Promise.all([
      this.prisma.company.findMany({
        where,
        orderBy: [{ title: 'asc' }],
        skip: query.offset,
        take: query.limit,
        include: {
          salesRepLinks: {
            where: { isActive: true },
            select: { salesRep: { select: { fullName: true } } },
            take: 1,
          },
        },
      }),
      this.prisma.company.count({ where }),
    ]);

    const kimlikler = bayiler.map((bayi) => bayi.id);
    const [sonSiparisler, sonZiyaretler, aylikCirolar] = await Promise.all([
      this.sonSiparisTarihleri(kimlikler),
      this.sonZiyaretTarihleri(kimlikler),
      bakiyeGorebilir ? this.aylikCirolar(kimlikler) : Promise.resolve(new Map()),
    ]);

    /* Bosta kalma suzgeci VERI CEKILDIKTEN sonra uygulanir: son siparis tarihi
       tek bir sorguda gruplanarak hesaplaniyor ve SQL tarafinda ayni suzgeci
       kurmak, sayfalama ile birlikte ikinci bir tam tarama gerektirirdi. */
    const esik =
      query.idleDays === undefined
        ? null
        : new Date(Date.now() - query.idleDays * 24 * 60 * 60 * 1000);

    const satirlar: CompanyListItem[] = bayiler
      .filter((bayi) => {
        if (esik === null) return true;
        const son = sonSiparisler.get(bayi.id);
        return son === undefined || son < esik;
      })
      .map((bayi) => ({
        id: bayi.id,
        title: bayi.title,
        logoCariCode: bayi.logoCariCode,
        city: bayi.city,
        district: bayi.district,
        phone: bayi.phone,
        isActive: bayi.isActive,
        isBlocked: bayi.isBlocked,
        ...(bakiyeGorebilir
          ? {
              balance: bayi.cachedBalance.toNumber(),
              overdueAmount: bayi.cachedOverdueAmount.toNumber(),
              creditLimit: bayi.creditLimit.toNumber(),
              monthlyOrderTotal: aylikCirolar.get(bayi.id) ?? 0,
            }
          : {}),
        currency: 'TRY',
        lastOrderAt: sonSiparisler.get(bayi.id)?.toISOString() ?? null,
        lastVisitAt: sonZiyaretler.get(bayi.id)?.toISOString() ?? null,
        assignedRepName: bayi.salesRepLinks[0]?.salesRep.fullName ?? null,
      }));

    return {
      companies: satirlar,
      totalCount: toplam,
      hasMore: query.offset + bayiler.length < toplam,
    };
  }

  private async sonSiparisTarihleri(companyIds: string[]): Promise<Map<string, Date>> {
    if (companyIds.length === 0) return new Map();

    const satirlar = await this.prisma.order.groupBy({
      by: ['companyId'],
      where: { companyId: { in: companyIds }, status: { in: CIRO_DURUMLARI } },
      _max: { submittedAt: true },
    });

    return new Map(
      satirlar
        .filter((satir) => satir._max.submittedAt !== null)
        .map((satir) => [satir.companyId, satir._max.submittedAt as Date]),
    );
  }

  private async sonZiyaretTarihleri(companyIds: string[]): Promise<Map<string, Date>> {
    if (companyIds.length === 0) return new Map();

    const satirlar = await this.prisma.visitNote.groupBy({
      by: ['companyId'],
      where: { companyId: { in: companyIds } },
      _max: { visitedAt: true },
    });

    return new Map(
      satirlar
        .filter((satir) => satir._max.visitedAt !== null)
        .map((satir) => [satir.companyId, satir._max.visitedAt as Date]),
    );
  }

  private async aylikCirolar(companyIds: string[]): Promise<Map<string, number>> {
    if (companyIds.length === 0) return new Map();

    const simdi = new Date();
    const ayBasi = new Date(Date.UTC(simdi.getUTCFullYear(), simdi.getUTCMonth(), 1));

    const satirlar = await this.prisma.order.groupBy({
      by: ['companyId'],
      where: {
        companyId: { in: companyIds },
        status: { in: CIRO_DURUMLARI },
        submittedAt: { gte: ayBasi },
      },
      _sum: { grandTotal: true },
    });

    return new Map(
      satirlar.map((satir) => [satir.companyId, satir._sum.grandTotal?.toNumber() ?? 0]),
    );
  }

  /**
   * Plasiyere bayi atar veya atamayi kaldirir.
   *
   * Atama KALDIRILIRKEN kayit silinmez, `isActive` false yapilir: gecmiste
   * kimin hangi bayiye baktigi, prim itirazlarinda sorulan ilk sorudur.
   */
  async assign(
    principal: AuthenticatedPrincipal,
    salesRepUserId: string,
    companyIds: string[],
    assign: boolean,
  ): Promise<{ affected: number }> {
    const plasiyer = await this.prisma.user.findFirst({
      where: { id: salesRepUserId, tenantId: principal.tenantId },
      select: { id: true },
    });

    if (!plasiyer) return { affected: 0 };

    /* Bayilerin kiraci denetimi: baska bir kiracinin bayisini atamak, kiraci
       yalitimini kirar. */
    const gecerliBayiler = await this.prisma.company.findMany({
      where: { id: { in: companyIds }, tenantId: principal.tenantId },
      select: { id: true },
    });

    let etkilenen = 0;

    for (const bayi of gecerliBayiler) {
      await this.prisma.salesRepAssignment.upsert({
        where: {
          salesRepUserId_companyId: { salesRepUserId, companyId: bayi.id },
        },
        create: { salesRepUserId, companyId: bayi.id, isActive: assign },
        update: {
          isActive: assign,
          revokedAt: assign ? null : new Date(),
          ...(assign ? { assignedAt: new Date() } : {}),
        },
      });

      etkilenen += 1;
    }

    return { affected: etkilenen };
  }
}
