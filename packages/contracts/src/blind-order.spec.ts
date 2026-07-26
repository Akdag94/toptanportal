/**
 * Kor Siparis alan sozlugunun testleri.
 *
 * Sozluk hem API suzgecinin hem istemcilerin ortak dayanagidir. Buradaki
 * testler, sozluge yeni bir finansal alan eklenmesi UNUTULDUGUNDA degil,
 * mevcut alanlarin YANLISLIKLA CIKARILMASI durumunda kirilir.
 */

import { describe, expect, it } from 'vitest';

import {
  BLIND_ORDER_STRIPPED_FIELDS,
  STOCK_STATUS_LABELS,
  StockStatus,
  isBlindOrderStrippedField,
  toStockStatus,
} from './blind-order';
import { cartLineSchema, orderViewSchema } from './order.schema';
import { catalogProductSchema, productUnitSchema } from './catalog.schema';

describe('Alan sözlüğü', () => {
  it('sözlükte yinelenen alan yoktur', () => {
    expect(new Set(BLIND_ORDER_STRIPPED_FIELDS).size).toBe(BLIND_ORDER_STRIPPED_FIELDS.length);
  });

  it('alan karşılaştırması büyük/küçük harf duyarsızdır', () => {
    expect(isBlindOrderStrippedField('unitPrice')).toBe(true);
    expect(isBlindOrderStrippedField('UNITPRICE')).toBe(true);
    expect(isBlindOrderStrippedField('UnitPrice')).toBe(true);
  });

  it('kimlik ve ürün alanlarını silmez', () => {
    for (const field of ['id', 'name', 'code', 'quantity', 'stockStatus', 'unitCode']) {
      expect(isBlindOrderStrippedField(field), `${field} yanlışlıkla siliniyor`).toBe(false);
    }
  });

  it('fiyat, iskonto, vergi, bakiye ve evrak alanlarını kapsar', () => {
    for (const field of [
      'price',
      'unitPrice',
      'discountRate',
      'vatAmount',
      'grandTotal',
      'balance',
      'creditLimit',
      'overdueAmount',
      'invoiceUrl',
      'unitCost',
      'margin',
    ]) {
      expect(isBlindOrderStrippedField(field), `${field} sözlükte yok`).toBe(true);
    }
  });
});

describe('Şemalarda finansal alanlar isteğe bağlıdır', () => {
  /**
   * Sunucu kor moddaki kullaniciya bu alanlari HIC gondermez. Sema onlari
   * zorunlu kilarsa, istemci dogrulamasi kor modda cokerdi.
   */
  it.each([
    ['catalogProductSchema', catalogProductSchema, ['price', 'vatRate', 'freeStock']],
    ['productUnitSchema', productUnitSchema, ['unitPrice']],
    [
      'cartLineSchema',
      cartLineSchema,
      ['unitPrice', 'grossAmount', 'discountTotal', 'netAmount', 'vatAmount', 'lineTotal'],
    ],
    [
      'orderViewSchema',
      orderViewSchema,
      ['grossTotal', 'discountTotal', 'netTotal', 'vatTotal', 'grandTotal', 'currency'],
    ],
  ] as const)('%s içinde %s alanları opsiyoneldir', (_name, schema, fields) => {
    for (const field of fields) {
      expect(schema.shape[field as keyof typeof schema.shape].isOptional()).toBe(true);
    }
  });

  it('kör modda gelen katalog yanıtı şemayı geçer', () => {
    const blindProduct = {
      id: '11111111-1111-4111-8111-111111111111',
      code: 'KHV-001',
      name: 'Çekirdek Kahve 1 kg',
      brand: null,
      categoryPath: null,
      imageUrl: null,
      baseUnitCode: 'ADET',
      units: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          code: 'KOLI',
          name: 'Koli',
          conversionFactor: 36,
          isBaseUnit: false,
          isDefaultForOrder: true,
        },
      ],
      stockStatus: StockStatus.IN_STOCK,
      minOrderQuantity: 0,
      maxOrderQuantity: null,
    };

    expect(catalogProductSchema.safeParse(blindProduct).success).toBe(true);
  });
});

describe('toStockStatus', () => {
  it('sıfır ve altını tükendi sayar', () => {
    expect(toStockStatus(0, 10)).toBe(StockStatus.OUT_OF_STOCK);
    expect(toStockStatus(-5, 10)).toBe(StockStatus.OUT_OF_STOCK);
  });

  it('eşik dahil olmak üzere altını kritik sayar', () => {
    expect(toStockStatus(10, 10)).toBe(StockStatus.CRITICAL);
    expect(toStockStatus(1, 10)).toBe(StockStatus.CRITICAL);
  });

  it('eşiğin üstünü stokta sayar', () => {
    expect(toStockStatus(11, 10)).toBe(StockStatus.IN_STOCK);
  });

  it('eşik sıfırsa var olan her stok "stokta" sayılır', () => {
    expect(toStockStatus(1, 0)).toBe(StockStatus.IN_STOCK);
  });

  it('her durum için Türkçe etiket tanımlıdır', () => {
    for (const status of Object.values(StockStatus)) {
      expect(STOCK_STATUS_LABELS[status]).toBeTruthy();
    }
  });
});
