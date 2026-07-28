/**
 * ToptanPortal API - Satis Hedefi ve Prim
 *
 * PRIM HESABI IKI SARTA BAGLIDIR ve ikisi de bilincli bir ticari karardir:
 *
 *   1. Ciro yalnizca ONAYLANMIS siparislerden sayilir. Iptal edilen siparis
 *      hedefe girseydi prim, teslim edilmemis mal uzerinden odenirdi.
 *   2. Prim TAHSIL EDILEN tutar oraninda odenir. Satip tahsil edememek,
 *      toptanci icin zarardir; primi ciro uzerinden odemek, plasiyeri odeme
 *      gucu olmayan bayiye satmaya tesvik eder.
 *
 * Gerceklesen ciro ONBELLEKLENMEZ. Her okumada hesaplanir; onbelleklenen bir
 * ciro, iptal edilen bir siparisten sonra sessizce yanlis kalir.
 */

import { Injectable } from '@nestjs/common';
import { OrderStatus, PaymentStatus, Prisma } from '@toptanportal/db';
import {
  Permission,
  roleHasPermission,
  type SalesTarget,
  type SalesTargetQuery,
  type UpsertSalesTargetRequest,
} from '@toptanportal/contracts';

import { PrismaService } from '../common/prisma/prisma.service';
import type { AuthenticatedPrincipal } from '../common/context/request-context';

const CIRO_DURUMLARI = [OrderStatus.CONFIRMED, OrderStatus.QUEUED, OrderStatus.SENDING];

@Injectable()
export class TargetService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    principal: AuthenticatedPrincipal,
    query: SalesTargetQuery,
  ): Promise<SalesTarget[]> {
    const period = query.period ?? bulunulanDonem();

    /* Plasiyer YALNIZCA kendi hedefini gorur. Baskasinin hedefini ve primini
       gormek, ekip icinde ucret bilgisinin sizmasi demektir; bunu istemci
       suzgecine birakmayiz. */
    const kendiHedefi = !roleHasPermission(principal.role, Permission.SALES_TARGET_MANAGE);
    const salesRepUserId = kendiHedefi ? principal.userId : query.salesRepUserId;

    const hedefler = await this.prisma.salesTarget.findMany({
      where: {
        tenantId: principal.tenantId,
        period,
        ...(salesRepUserId ? { salesRepUserId } : {}),
      },
      include: { salesRep: { select: { fullName: true } } },
      orderBy: { targetAmount: 'desc' },
    });

    return Promise.all(hedefler.map((hedef) => this.hesapla(hedef)));
  }

  async upsert(
    principal: AuthenticatedPrincipal,
    request: UpsertSalesTargetRequest,
  ): Promise<SalesTarget> {
    const hedef = await this.prisma.salesTarget.upsert({
      where: {
        salesRepUserId_period: {
          salesRepUserId: request.salesRepUserId,
          period: request.period,
        },
      },
      create: {
        tenantId: principal.tenantId,
        salesRepUserId: request.salesRepUserId,
        period: request.period,
        targetAmount: request.targetAmount,
        commissionRate: request.commissionRate,
        updatedByUserId: principal.userId,
      },
      update: {
        targetAmount: request.targetAmount,
        commissionRate: request.commissionRate,
        updatedByUserId: principal.userId,
      },
      include: { salesRep: { select: { fullName: true } } },
    });

    return this.hesapla(hedef);
  }

  /**
   * Donemin gerceklesenini hesaplar.
   *
   * Ciro, plasiyerin PORTFOYUNDEKI bayilerin siparislerinden gelir - siparisi
   * kimin girdiginden degil. Bayi portalden kendi siparisini verdiginde de
   * plasiyerin emegi vardir; primi yalnizca plasiyerin elle girdigi
   * siparislere baglamak, portalin benimsenmesini plasiyerin cikarina AYKIRI
   * hale getirirdi.
   */
  private async hesapla(
    hedef: Prisma.SalesTargetGetPayload<{ include: { salesRep: { select: { fullName: true } } } }>,
  ): Promise<SalesTarget> {
    const { start, end } = donemAraligi(hedef.period);

    const portfoy = await this.prisma.salesRepAssignment.findMany({
      where: { salesRepUserId: hedef.salesRepUserId, isActive: true },
      select: { companyId: true },
    });

    const companyIds = portfoy.map((satir) => satir.companyId);

    const [ciro, tahsilat] = await Promise.all([
      companyIds.length === 0
        ? Promise.resolve(null)
        : this.prisma.order.aggregate({
            where: {
              companyId: { in: companyIds },
              status: { in: CIRO_DURUMLARI },
              submittedAt: { gte: start, lt: end },
            },
            _sum: { grandTotal: true },
          }),
      companyIds.length === 0
        ? Promise.resolve(null)
        : this.prisma.payment.aggregate({
            where: {
              companyId: { in: companyIds },
              status: PaymentStatus.CONFIRMED,
              receivedAt: { gte: start, lt: end },
            },
            _sum: { amount: true },
          }),
    ]);

    const target = hedef.targetAmount.toNumber();
    const achieved = ciro?._sum.grandTotal?.toNumber() ?? 0;
    const collected = tahsilat?._sum.amount?.toNumber() ?? 0;

    const achievementRate = target > 0 ? round2((achieved / target) * 100) : 0;
    const collectionRate = achieved > 0 ? round2((collected / achieved) * 100) : 0;

    /* Prim yalnizca hedef TUTTURULDUGUNDA hesaplanir ve tahsilat orani kadar
       odenir. Hedefin %99'unda prim vermemek sert bir kuraldir; kademeli prim
       istenirse burasi degisir, ama varsayilan olarak esik nettir. */
    const commissionAmount =
      achievementRate >= 100
        ? round2((achieved * hedef.commissionRate.toNumber() * (collectionRate / 100)) / 100)
        : 0;

    return {
      id: hedef.id,
      salesRepUserId: hedef.salesRepUserId,
      salesRepName: hedef.salesRep.fullName,
      period: hedef.period,
      targetAmount: target,
      achievedAmount: achieved,
      achievementRate,
      currency: hedef.currency,
      commissionRate: hedef.commissionRate.toNumber(),
      commissionAmount,
      collectedAmount: collected,
      collectionRate,
      updatedAt: hedef.updatedAt.toISOString(),
    };
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function bulunulanDonem(): string {
  const simdi = new Date();
  return `${simdi.getUTCFullYear()}-${String(simdi.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** `2026-07` -> [2026-07-01, 2026-08-01) */
function donemAraligi(period: string): { start: Date; end: Date } {
  const [yil, ay] = period.split('-').map(Number);
  const start = new Date(Date.UTC(yil ?? 2026, (ay ?? 1) - 1, 1));
  const end = new Date(Date.UTC(yil ?? 2026, ay ?? 1, 1));
  return { start, end };
}
