/**
 * Stok gorunurlugu ve rezervasyon testleri.
 *
 * Buradaki kural tek cumleyle: AYNI STOK IKI KEZ SATILAMAZ. Rezervasyonun
 * satir kilidi altinda yapilmasi ve yetersiz stokta hicbir yan etki
 * birakmamasi test altindadir.
 */

import type { PrismaTransactionClient } from '@toptanportal/db';

import type { PrismaService } from '../common/prisma/prisma.service';
import { Decimal } from '../pricing/pricing.types';
import { StockService, StockShortageError } from './stock.service';

const WAREHOUSE_ID = 'wh-1';
const PRODUCT_A = 'aaaa1111-1111-4111-8111-111111111111';
const PRODUCT_B = 'bbbb2222-2222-4222-8222-222222222222';

function buildPrisma(options: {
  snapshots?: { productId: string; onHand: number; logoReserved: number; portalReserved: number }[];
  thresholds?: { id: string; criticalStockThreshold: number }[];
}) {
  return {
    stockSnapshot: {
      findMany: jest.fn().mockResolvedValue(
        (options.snapshots ?? []).map((s) => ({
          productId: s.productId,
          onHand: new Decimal(s.onHand),
          logoReserved: new Decimal(s.logoReserved),
          portalReserved: new Decimal(s.portalReserved),
        })),
      ),
    },
    product: {
      findMany: jest.fn().mockResolvedValue(
        (options.thresholds ?? []).map((t) => ({
          id: t.id,
          criticalStockThreshold: new Decimal(t.criticalStockThreshold),
        })),
      ),
    },
  } as unknown as PrismaService;
}

function buildTx(rows: Record<string, { onHand: string; portalReserved: string }>) {
  const updates: { id: string; increment: string }[] = [];
  const reservations: { productId: string; quantity: string }[] = [];

  const tx = {
    $queryRaw: jest.fn().mockImplementation((strings: TemplateStringsArray, productId: string) => {
      void strings;
      const row = rows[productId];
      return Promise.resolve(
        row
          ? [
              {
                id: `snapshot-${productId}`,
                on_hand: row.onHand,
                logo_reserved: '0',
                portal_reserved: row.portalReserved,
              },
            ]
          : [],
      );
    }),
    stockSnapshot: {
      update: jest.fn().mockImplementation((args: { where: { id: string }; data: { portalReserved: { increment: Decimal } } }) => {
        updates.push({ id: args.where.id, increment: args.data.portalReserved.increment.toString() });
        return Promise.resolve({});
      }),
    },
    stockReservation: {
      create: jest.fn().mockImplementation((args: { data: { productId: string; quantity: Decimal } }) => {
        reservations.push({
          productId: args.data.productId,
          quantity: args.data.quantity.toString(),
        });
        return Promise.resolve({});
      }),
    },
  } as unknown as PrismaTransactionClient;

  return { tx, updates, reservations };
}

function request(productId: string, baseQuantity: number) {
  return {
    productId,
    productName: `Ürün ${productId.slice(0, 4)}`,
    unitCode: 'KOLI',
    baseQuantity: new Decimal(baseQuantity),
    requestedQuantity: new Decimal(baseQuantity),
  };
}

describe('StockService.getFreeStock', () => {
  it('serbest stoğu onHand - logoReserved - portalReserved olarak hesaplar', async () => {
    const service = new StockService(
      buildPrisma({
        snapshots: [{ productId: PRODUCT_A, onHand: 100, logoReserved: 30, portalReserved: 25 }],
        thresholds: [{ id: PRODUCT_A, criticalStockThreshold: 10 }],
      }),
    );

    const rows = await service.getFreeStock([PRODUCT_A], WAREHOUSE_ID);

    expect(rows.get(PRODUCT_A)?.freeStock.toString()).toBe('45');
    expect(rows.get(PRODUCT_A)?.status).toBe('IN_STOCK');
  });

  it('eşiğin altındaki stoğu kritik sayar', async () => {
    const service = new StockService(
      buildPrisma({
        snapshots: [{ productId: PRODUCT_A, onHand: 12, logoReserved: 0, portalReserved: 4 }],
        thresholds: [{ id: PRODUCT_A, criticalStockThreshold: 10 }],
      }),
    );

    expect((await service.getFreeStock([PRODUCT_A], WAREHOUSE_ID)).get(PRODUCT_A)?.status).toBe(
      'CRITICAL',
    );
  });

  it('stok kaydı olmayan ürünü tükendi sayar — kaydın yokluğu stok delili değildir', async () => {
    const service = new StockService(buildPrisma({}));

    const row = (await service.getFreeStock([PRODUCT_A], WAREHOUSE_ID)).get(PRODUCT_A);

    expect(row?.freeStock.toString()).toBe('0');
    expect(row?.status).toBe('OUT_OF_STOCK');
  });

  it('rezervler fiziki stoğu aşarsa negatife düşer ve tükendi sayılır', async () => {
    const service = new StockService(
      buildPrisma({
        snapshots: [{ productId: PRODUCT_A, onHand: 10, logoReserved: 6, portalReserved: 8 }],
        thresholds: [{ id: PRODUCT_A, criticalStockThreshold: 0 }],
      }),
    );

    const row = (await service.getFreeStock([PRODUCT_A], WAREHOUSE_ID)).get(PRODUCT_A);

    expect(row?.freeStock.toString()).toBe('-4');
    expect(row?.status).toBe('OUT_OF_STOCK');
  });
});

describe('StockService.reserve', () => {
  const service = new StockService(buildPrisma({}));

  it('yeterli stokta rezervi yazar ve sayacı artırır', async () => {
    const { tx, updates, reservations } = buildTx({
      [PRODUCT_A]: { onHand: '100', portalReserved: '10' },
    });

    await service.reserve(tx, {
      orderId: 'order-1',
      warehouseId: WAREHOUSE_ID,
      requests: [request(PRODUCT_A, 20)],
      pendingApproval: false,
    });

    expect(updates).toEqual([{ id: `snapshot-${PRODUCT_A}`, increment: '20' }]);
    expect(reservations).toEqual([{ productId: PRODUCT_A, quantity: '20' }]);
  });

  it('serbest stok yetmiyorsa hata fırlatır ve sayacı artırmaz', async () => {
    const { tx, updates, reservations } = buildTx({
      [PRODUCT_A]: { onHand: '100', portalReserved: '95' },
    });

    await expect(
      service.reserve(tx, {
        orderId: 'order-1',
        warehouseId: WAREHOUSE_ID,
        requests: [request(PRODUCT_A, 20)],
        pendingApproval: false,
      }),
    ).rejects.toBeInstanceOf(StockShortageError);

    expect(updates).toHaveLength(0);
    expect(reservations).toHaveLength(0);
  });

  it('eksik kalan tüm satırları tek seferde raporlar', async () => {
    const { tx } = buildTx({
      [PRODUCT_A]: { onHand: '5', portalReserved: '0' },
      [PRODUCT_B]: { onHand: '1', portalReserved: '0' },
    });

    const error = await service
      .reserve(tx, {
        orderId: 'order-1',
        warehouseId: WAREHOUSE_ID,
        requests: [request(PRODUCT_A, 10), request(PRODUCT_B, 10)],
        pendingApproval: false,
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StockShortageError);
    expect((error as StockShortageError).shortages).toHaveLength(2);
    expect((error as StockShortageError).shortages[0]?.available).toBe(5);
  });

  it('stok kaydı olmayan ürün için rezerv yazmaz', async () => {
    const { tx, updates } = buildTx({});

    await expect(
      service.reserve(tx, {
        orderId: 'order-1',
        warehouseId: WAREHOUSE_ID,
        requests: [request(PRODUCT_A, 1)],
        pendingApproval: false,
      }),
    ).rejects.toBeInstanceOf(StockShortageError);

    expect(updates).toHaveLength(0);
  });

  it('satırları ürün kimliğine göre sıralı kilitler — karşılıklı kilitlenmeyi önler', async () => {
    const { tx } = buildTx({
      [PRODUCT_A]: { onHand: '100', portalReserved: '0' },
      [PRODUCT_B]: { onHand: '100', portalReserved: '0' },
    });

    await service.reserve(tx, {
      orderId: 'order-1',
      warehouseId: WAREHOUSE_ID,
      // Bilincli olarak ters sirada verilir.
      requests: [request(PRODUCT_B, 1), request(PRODUCT_A, 1)],
      pendingApproval: false,
    });

    const lockedOrder = (tx.$queryRaw as jest.Mock).mock.calls.map((call) => call[1] as string);

    expect(lockedOrder).toEqual([PRODUCT_A, PRODUCT_B]);
  });
});
