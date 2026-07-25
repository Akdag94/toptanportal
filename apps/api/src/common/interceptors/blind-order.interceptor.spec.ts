/**
 * Kor Siparis suzgecinin davranis testleri.
 *
 * Bu testler bir "uyumluluk kalkani"dir: katalog yanitina yeni bir finansal
 * alan eklendiginde ve sozluge yazilmadiginda kirilmalari beklenir.
 */

import { stripFinancialFields } from './blind-order.interceptor';

function strip(value: unknown): unknown {
  return stripFinancialFields(value, 0, new WeakSet()).value;
}

function strippedNames(value: unknown): string[] {
  return [...new Set(stripFinancialFields(value, 0, new WeakSet()).strippedFields)].sort();
}

describe('stripFinancialFields', () => {
  it('ürün kartından fiyat ve iskonto alanlarını siler, kimlik alanlarını korur', () => {
    const product = {
      id: 'p-1',
      name: 'Çekirdek Kahve 1 kg',
      unit: 'KOLİ',
      stockStatus: 'IN_STOCK',
      price: 480.5,
      listPrice: 520,
      discountRate: 8,
      vatRate: 20,
    };

    expect(strip(product)).toEqual({
      id: 'p-1',
      name: 'Çekirdek Kahve 1 kg',
      unit: 'KOLİ',
      stockStatus: 'IN_STOCK',
    });
  });

  it('iç içe ve dizi yapılardaki finansal alanları da temizler', () => {
    const order = {
      id: 'o-1',
      status: 'PENDING_APPROVAL',
      grandTotal: 12500,
      lines: [
        { productId: 'p-1', quantity: 4, unitPrice: 480.5, lineTotal: 1922 },
        { productId: 'p-2', quantity: 2, unitPrice: 120, lineTotal: 240 },
      ],
      company: {
        id: 'c-1',
        title: 'Mavi Kapı Kahve',
        balance: -48000,
        creditLimit: 250000,
      },
    };

    expect(strip(order)).toEqual({
      id: 'o-1',
      status: 'PENDING_APPROVAL',
      lines: [
        { productId: 'p-1', quantity: 4 },
        { productId: 'p-2', quantity: 2 },
      ],
      company: { id: 'c-1', title: 'Mavi Kapı Kahve' },
    });
  });

  it('alan adlarını büyük/küçük harf duyarsız eşleştirir', () => {
    expect(strip({ UnitPrice: 10, TOTAL: 20, keep: 'x' })).toEqual({ keep: 'x' });
  });

  it('silinen alan adlarını raporlar', () => {
    const payload = { price: 1, nested: { balance: 2, ok: 3 }, list: [{ vatAmount: 4 }] };
    expect(strippedNames(payload)).toEqual(['balance', 'price', 'vatAmount']);
  });

  it('girdi nesnesini değiştirmez', () => {
    const original = { id: 'p-1', price: 100 };
    strip(original);
    expect(original.price).toBe(100);
  });

  it('tarih ve ikili verileri olduğu gibi bırakır', () => {
    const createdAt = new Date('2026-07-26T08:00:00.000Z');
    const result = strip({ createdAt, blob: Buffer.from('abc') }) as Record<string, unknown>;

    expect(result.createdAt).toBe(createdAt);
    expect(Buffer.isBuffer(result.blob)).toBe(true);
  });

  it('döngüsel referansta sonsuz döngüye girmez', () => {
    const node: Record<string, unknown> = { id: 'n-1', price: 5 };
    node.self = node;

    expect(() => strip(node)).not.toThrow();
  });

  it('stok durumu ve miktar gibi operasyonel alanlara dokunmaz', () => {
    const payload = { stockStatus: 'CRITICAL', quantity: 12, unit: 'ADET' };
    expect(strip(payload)).toEqual(payload);
  });

  it('kritik sızıntı alanlarının tamamını kapsar', () => {
    const leaky = {
      price: 1,
      unitPrice: 1,
      listPrice: 1,
      discount: 1,
      discountRate: 1,
      discountAmount: 1,
      vat: 1,
      vatRate: 1,
      vatAmount: 1,
      tax: 1,
      taxAmount: 1,
      total: 1,
      grandTotal: 1,
      subTotal: 1,
      lineTotal: 1,
      balance: 1,
      creditLimit: 1,
      availableCredit: 1,
      overdueAmount: 1,
      overdueDays: 1,
      invoiceUrl: 'x',
      invoiceNumber: 'x',
      cost: 1,
      margin: 1,
      safe: 'kalmalı',
    };

    expect(strip(leaky)).toEqual({ safe: 'kalmalı' });
  });
});
