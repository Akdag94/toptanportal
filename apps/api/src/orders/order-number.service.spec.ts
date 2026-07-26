/**
 * Siparis numarasi uretiminin testleri.
 *
 * Numaradaki bosluk, denetimde "silinmis siparis var mi" sorusunu dogurur;
 * bu yuzden artis kurali ve kilit cagrisi test altindadir.
 */

import type { PrismaTransactionClient } from '@toptanportal/db';

import { OrderNumberService } from './order-number.service';

function buildTx(lastOrderNumber: string | null) {
  return {
    $executeRaw: jest.fn().mockResolvedValue(1),
    order: {
      findFirst: jest
        .fn()
        .mockResolvedValue(lastOrderNumber ? { orderNumber: lastOrderNumber } : null),
    },
  } as unknown as PrismaTransactionClient & {
    $executeRaw: jest.Mock;
    order: { findFirst: jest.Mock };
  };
}

const TENANT = 'tenant-1';
const AT = new Date('2026-07-26T10:00:00Z');

describe('OrderNumberService', () => {
  let service: OrderNumberService;

  beforeEach(() => {
    service = new OrderNumberService();
  });

  it('yılın ilk siparişine 1 numarasını verir', async () => {
    const tx = buildTx(null);

    expect(await service.next(tx, TENANT, AT)).toBe('SP-2026-000001');
  });

  it('son numarayı bir artırır', async () => {
    const tx = buildTx('SP-2026-000416');

    expect(await service.next(tx, TENANT, AT)).toBe('SP-2026-000417');
  });

  it('altı haneyi aşan numarayı kırpmaz', async () => {
    const tx = buildTx('SP-2026-999999');

    expect(await service.next(tx, TENANT, AT)).toBe('SP-2026-1000000');
  });

  it('numarayı üretmeden önce kiracı bazlı kilit alır', async () => {
    const tx = buildTx('SP-2026-000005');

    await service.next(tx, TENANT, AT);

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    // Kilit, son numara okunmadan ONCE alinmalidir; aksi halde iki istek ayni
    // numarayi uretebilir.
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.order.findFirst.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it('yalnızca o yılın numaralarına bakar', async () => {
    const tx = buildTx('SP-2026-000010');

    await service.next(tx, TENANT, new Date('2027-01-02T00:00:00Z'));

    const where = tx.order.findFirst.mock.calls[0]?.[0]?.where as {
      orderNumber: { startsWith: string };
    };

    expect(where.orderNumber.startsWith).toBe('SP-2027-');
  });
});
