/**
 * Harcama limiti kararlarinin testleri.
 *
 * Bu kurallar isletme sahibinin alt kullanicilarina duydugu guvenin teknik
 * karsiligidir; gevsetilmesi dogrudan mali risk yaratir.
 */

import type { PrismaService } from '../common/prisma/prisma.service';
import { Decimal } from '../pricing/pricing.types';
import { SpendingLimitService } from './spending-limit.service';

interface LimitRow {
  perOrderLimit: Decimal | null;
  dailyLimit: Decimal | null;
  monthlyLimit: Decimal | null;
  alwaysRequiresApproval: boolean;
}

function buildService(options: { limit: LimitRow | null; spent?: number }) {
  const prisma = {
    userSpendingLimit: {
      findUnique: jest.fn().mockResolvedValue(options.limit),
    },
    order: {
      aggregate: jest
        .fn()
        .mockResolvedValue({ _sum: { grandTotal: new Decimal(options.spent ?? 0) } }),
    },
  } as unknown as PrismaService;

  return { service: new SpendingLimitService(prisma), prisma };
}

function limit(overrides: Partial<LimitRow> = {}): LimitRow {
  return {
    perOrderLimit: null,
    dailyLimit: null,
    monthlyLimit: null,
    alwaysRequiresApproval: false,
    ...overrides,
  };
}

const BASE = {
  userId: 'user-1',
  companyId: 'company-1',
  canPlaceDirectly: true,
};

describe('SpendingLimitService', () => {
  it('sipariş verme yetkisi olmayan kullanıcıyı daima onaya düşürür', async () => {
    const { service } = buildService({ limit: null });

    const decision = await service.evaluate({
      ...BASE,
      canPlaceDirectly: false,
      grandTotal: new Decimal(1),
    });

    expect(decision).toEqual({ requiresApproval: true, reason: 'ROLE_CANNOT_PLACE' });
  });

  it('limit tanımlı değilse siparişi doğrudan geçirir', async () => {
    const { service } = buildService({ limit: null });

    const decision = await service.evaluate({ ...BASE, grandTotal: new Decimal(100000) });

    expect(decision.requiresApproval).toBe(false);
  });

  it('alwaysRequiresApproval tutardan bağımsız olarak onaya düşürür', async () => {
    const { service } = buildService({ limit: limit({ alwaysRequiresApproval: true }) });

    const decision = await service.evaluate({ ...BASE, grandTotal: new Decimal(1) });

    expect(decision).toEqual({ requiresApproval: true, reason: 'ALWAYS_REQUIRES_APPROVAL' });
  });

  it('sipariş başına limiti aşan tutarı onaya düşürür', async () => {
    const { service } = buildService({ limit: limit({ perOrderLimit: new Decimal(5000) }) });

    const decision = await service.evaluate({ ...BASE, grandTotal: new Decimal(5000.01) });

    expect(decision).toEqual({ requiresApproval: true, reason: 'PER_ORDER_LIMIT' });
  });

  it('limite eşit tutarı geçirir — sınır dahildir', async () => {
    const { service } = buildService({ limit: limit({ perOrderLimit: new Decimal(5000) }) });

    const decision = await service.evaluate({ ...BASE, grandTotal: new Decimal(5000) });

    expect(decision.requiresApproval).toBe(false);
  });

  it('günlük limitte önceki siparişleri de sayar', async () => {
    const { service } = buildService({
      limit: limit({ dailyLimit: new Decimal(10000) }),
      spent: 9500,
    });

    const decision = await service.evaluate({ ...BASE, grandTotal: new Decimal(600) });

    expect(decision).toEqual({ requiresApproval: true, reason: 'DAILY_LIMIT' });
  });

  it('günlük limit içinde kalan siparişi geçirir', async () => {
    const { service } = buildService({
      limit: limit({ dailyLimit: new Decimal(10000) }),
      spent: 9500,
    });

    const decision = await service.evaluate({ ...BASE, grandTotal: new Decimal(500) });

    expect(decision.requiresApproval).toBe(false);
  });

  it('günlük limit içinde kalan ama aylık limiti aşan siparişi onaya düşürür', async () => {
    const { service } = buildService({
      limit: limit({ dailyLimit: new Decimal(25000), monthlyLimit: new Decimal(20000) }),
      spent: 19000,
    });

    // 19.000 + 1.500 -> gunluk 25.000 sinirinin altinda, aylik 20.000'in ustunde.
    const decision = await service.evaluate({ ...BASE, grandTotal: new Decimal(1500) });

    expect(decision).toEqual({ requiresApproval: true, reason: 'MONTHLY_LIMIT' });
  });

  it('onay bekleyen siparişleri de toplama dahil eder', async () => {
    const { service, prisma } = buildService({
      limit: limit({ dailyLimit: new Decimal(1000) }),
      spent: 0,
    });

    await service.evaluate({ ...BASE, grandTotal: new Decimal(1) });

    const call = (prisma.order.aggregate as jest.Mock).mock.calls[0]?.[0] as {
      where: { status: { in: string[] } };
    };

    expect(call.where.status.in).toContain('PENDING_APPROVAL');
  });
});
