/**
 * ToptanPortal - Harcama Limiti Denetimi
 *
 * Isletme ana yetkilisi, alt kullanicilarina tutar limiti tanimlar. KRITIK
 * TASARIM KARARI: alt kullanici limiti de, tutari da GORMEZ. Limit asildiginda
 * "limitiniz 5.000 TL, sipariste 6.200 TL" denmez - bu, tutari dolayli yoldan
 * sizdirirdi. Yalnizca "siparis onaya gonderildi" denir.
 *
 * Limit kontrolu daima sunucudadir; istemciye asla tasinmaz.
 */

import { Injectable } from '@nestjs/common';
import { OrderStatus } from '@toptanportal/db';

import { PrismaService } from '../common/prisma/prisma.service';
import { Decimal } from '../pricing/pricing.types';

/** Onaya dusuren sebep - denetim kaydina yazilir, kullaniciya gosterilmez. */
export type ApprovalReason =
  | 'ROLE_CANNOT_PLACE'
  | 'ALWAYS_REQUIRES_APPROVAL'
  | 'PER_ORDER_LIMIT'
  | 'DAILY_LIMIT'
  | 'MONTHLY_LIMIT';

export interface ApprovalDecision {
  requiresApproval: boolean;
  reason: ApprovalReason | null;
}

/** Onaya dusen siparisler de gunluk/aylik toplama dahildir - aksi halde limit,
 *  arka arkaya siparis acarak asilabilirdi. */
const COUNTED_STATUSES = [
  OrderStatus.PENDING_APPROVAL,
  OrderStatus.QUEUED,
  OrderStatus.SENDING,
  OrderStatus.CONFIRMED,
];

@Injectable()
export class SpendingLimitService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * @param canPlaceDirectly ORDER_PLACE yetkisi. Yoksa siparis her halukarda
   *   onaya duser (kor moddaki alt yetkilinin durumu).
   */
  async evaluate(params: {
    userId: string;
    companyId: string;
    grandTotal: Decimal;
    canPlaceDirectly: boolean;
    at?: Date;
  }): Promise<ApprovalDecision> {
    if (!params.canPlaceDirectly) {
      return { requiresApproval: true, reason: 'ROLE_CANNOT_PLACE' };
    }

    const limit = await this.prisma.userSpendingLimit.findUnique({
      where: { userId: params.userId },
      select: {
        perOrderLimit: true,
        dailyLimit: true,
        monthlyLimit: true,
        alwaysRequiresApproval: true,
      },
    });

    if (!limit) {
      return { requiresApproval: false, reason: null };
    }

    if (limit.alwaysRequiresApproval) {
      return { requiresApproval: true, reason: 'ALWAYS_REQUIRES_APPROVAL' };
    }

    if (limit.perOrderLimit !== null && params.grandTotal.greaterThan(limit.perOrderLimit)) {
      return { requiresApproval: true, reason: 'PER_ORDER_LIMIT' };
    }

    const at = params.at ?? new Date();

    if (limit.dailyLimit !== null) {
      const spent = await this.sumSince(params, startOfDay(at));

      if (spent.plus(params.grandTotal).greaterThan(limit.dailyLimit)) {
        return { requiresApproval: true, reason: 'DAILY_LIMIT' };
      }
    }

    if (limit.monthlyLimit !== null) {
      const spent = await this.sumSince(params, startOfMonth(at));

      if (spent.plus(params.grandTotal).greaterThan(limit.monthlyLimit)) {
        return { requiresApproval: true, reason: 'MONTHLY_LIMIT' };
      }
    }

    return { requiresApproval: false, reason: null };
  }

  private async sumSince(
    params: { userId: string; companyId: string },
    since: Date,
  ): Promise<Decimal> {
    const result = await this.prisma.order.aggregate({
      where: {
        createdByUserId: params.userId,
        companyId: params.companyId,
        status: { in: COUNTED_STATUSES },
        submittedAt: { gte: since },
      },
      _sum: { grandTotal: true },
    });

    return new Decimal(result._sum.grandTotal ?? 0);
  }
}

function startOfDay(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate(), 0, 0, 0, 0);
}

function startOfMonth(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), 1, 0, 0, 0, 0);
}
