/**
 * Cari hesap aritmetiginin testleri.
 *
 * Yaslandirma raporu tahsilat baskisinin, FIFO dagitimi ise hangi faturanin
 * kapandiginin belirleyicisidir. Ikisi de bayi ile toptanci arasinda tartisma
 * konusu olabilecek hesaplardir; davranis burada kilitlenir.
 */

import { Decimal } from '../pricing/pricing.types';
import { allocateFifo, buildAging, overdueDays, type OpenDocument } from './account-math';

/** Tarihler UTC gun basi olarak kurulur - Prisma `@db.Date` alanlari boyle doner. */
function day(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function doc(overrides: Partial<OpenDocument> & { id: string }): OpenDocument {
  return {
    dueDate: null,
    entryDate: day('2026-01-01'),
    openAmount: new Decimal(100),
    ...overrides,
  };
}

const TODAY = day('2026-03-31');

describe('overdueDays', () => {
  it('vadesi bugun dolan belgeyi gecikmis saymaz', () => {
    expect(overdueDays(day('2026-03-31'), TODAY)).toBe(0);
  });

  it('vade gununden bir gun sonra 1 doner', () => {
    expect(overdueDays(day('2026-03-30'), TODAY)).toBe(1);
  });

  it('vadesi gelmemis belgede 0 doner', () => {
    expect(overdueDays(day('2026-04-15'), TODAY)).toBe(0);
  });

  it('vadesi tanimsiz belgede 0 doner', () => {
    expect(overdueDays(null, TODAY)).toBe(0);
  });
});

describe('buildAging', () => {
  it('belgeleri gecikme kovalarina dagitir', () => {
    const result = buildAging(
      [
        doc({ id: 'a', dueDate: day('2026-04-10'), openAmount: new Decimal(1000) }), // vadesi gelmemis
        doc({ id: 'b', dueDate: day('2026-03-20'), openAmount: new Decimal(500) }), // 11 gun
        doc({ id: 'c', dueDate: day('2026-02-14'), openAmount: new Decimal(250) }), // 45 gun
        doc({ id: 'd', dueDate: day('2026-01-15'), openAmount: new Decimal(120) }), // 75 gun
        doc({ id: 'e', dueDate: day('2025-11-01'), openAmount: new Decimal(80) }), // 150 gun
      ],
      TODAY,
    );

    const amounts = Object.fromEntries(
      result.buckets.map((bucket) => [bucket.key, bucket.amount.toNumber()]),
    );

    expect(amounts).toEqual({
      NOT_DUE: 1000,
      DAYS_1_30: 500,
      DAYS_31_60: 250,
      DAYS_61_90: 120,
      DAYS_90_PLUS: 80,
    });
    expect(result.totalOpen.toNumber()).toBe(1950);
    expect(result.totalOverdue.toNumber()).toBe(950);
    expect(result.oldestOverdueDays).toBe(150);
  });

  it('vadesi tanimsiz belgeyi 90+ kovasina degil, vadesi gelmemise koyar', () => {
    const result = buildAging([doc({ id: 'a', dueDate: null })], TODAY);
    const notDue = result.buckets.find((bucket) => bucket.key === 'NOT_DUE');

    expect(notDue?.amount.toNumber()).toBe(100);
    expect(result.totalOverdue.toNumber()).toBe(0);
  });

  it('kapanmis belgeyi rapora almaz', () => {
    const result = buildAging(
      [doc({ id: 'a', dueDate: day('2026-01-01'), openAmount: new Decimal(0) })],
      TODAY,
    );

    expect(result.totalOpen.toNumber()).toBe(0);
    expect(result.buckets.every((bucket) => bucket.documentCount === 0)).toBe(true);
  });
});

describe('allocateFifo', () => {
  const documents: OpenDocument[] = [
    doc({ id: 'yeni', dueDate: day('2026-04-01'), openAmount: new Decimal(300) }),
    doc({ id: 'eski', dueDate: day('2026-01-10'), openAmount: new Decimal(200) }),
    doc({ id: 'orta', dueDate: day('2026-02-10'), openAmount: new Decimal(150) }),
  ];

  it('once vadesi en eski belgeyi kapatir', () => {
    const result = allocateFifo(documents, new Decimal(250));

    expect(result.allocations).toEqual([
      { entryId: 'eski', amount: new Decimal(200) },
      { entryId: 'orta', amount: new Decimal(50) },
    ]);
    expect(result.unallocated.toNumber()).toBe(0);
  });

  it('artan tutari avans olarak birakir', () => {
    const result = allocateFifo(documents, new Decimal(1000));

    expect(result.allocations).toHaveLength(3);
    expect(result.unallocated.toNumber()).toBe(350);
  });

  it('vadesi olmayan belgeyi belge tarihine gore siralar', () => {
    const result = allocateFifo(
      [
        doc({ id: 'vadesiz', dueDate: null, entryDate: day('2025-12-01') }),
        doc({ id: 'vadeli', dueDate: day('2026-01-05') }),
      ],
      new Decimal(50),
    );

    expect(result.allocations).toEqual([{ entryId: 'vadesiz', amount: new Decimal(50) }]);
  });

  it('esit vadede kararli sirayla dagitir', () => {
    const sameDue = [
      doc({ id: 'b2', dueDate: day('2026-02-01'), openAmount: new Decimal(60) }),
      doc({ id: 'a1', dueDate: day('2026-02-01'), openAmount: new Decimal(60) }),
    ];

    expect(allocateFifo(sameDue, new Decimal(60)).allocations).toEqual(
      allocateFifo([...sameDue].reverse(), new Decimal(60)).allocations,
    );
  });

  it('kapanmis belgeye dagitim yapmaz', () => {
    const result = allocateFifo(
      [doc({ id: 'kapali', dueDate: day('2026-01-01'), openAmount: new Decimal(0) })],
      new Decimal(100),
    );

    expect(result.allocations).toHaveLength(0);
    expect(result.unallocated.toNumber()).toBe(100);
  });
});
