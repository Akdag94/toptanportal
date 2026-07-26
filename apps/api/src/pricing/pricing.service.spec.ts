/**
 * Fiyatlandirma motorunun davranis testleri.
 *
 * Bu testler ticari sozlesme niteligindedir: bir musteri "hesap yanlis" derse
 * dayanak burasidir. Ozellikle zincirli iskonto (%10 + %5 != %15) ve birim
 * cevrimi senaryolari degistirilirken cok dikkatli olunmalidir.
 */

import { PricingService } from './pricing.service';
import {
  Decimal,
  type DiscountKind,
  type DiscountRuleData,
  type PriceEntry,
  type PricedLine,
  type PricedOrder,
  type PricingContext,
  type PricingProduct,
} from './pricing.types';

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PRODUCT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KOLI_ID = '22222222-2222-4222-8222-222222222222';
const ADET_ID = '33333333-3333-4333-8333-333333333333';

/** 1 Koli = 36 Adet; ana birim Adet. */
function coffee(overrides: { id?: string; vatRate?: number } = {}): PricingProduct {
  return {
    id: overrides.id ?? PRODUCT_ID,
    code: 'KHV-001',
    name: 'Çekirdek Kahve 1 kg',
    vatRate: new Decimal(overrides.vatRate ?? 20),
    baseUnitCode: 'ADET',
    units: [
      {
        id: ADET_ID,
        code: 'ADET',
        name: 'Adet',
        conversionFactor: new Decimal(1),
        isBaseUnit: true,
      },
      {
        id: KOLI_ID,
        code: 'KOLI',
        name: 'Koli',
        conversionFactor: new Decimal(36),
        isBaseUnit: false,
      },
    ],
  };
}

function buildContext(overrides: Partial<PricingContext> = {}): PricingContext {
  return {
    priceListId: 'pl-1',
    priceListName: 'Genel Liste',
    currency: 'TRY',
    vatIncluded: false,
    products: new Map([[PRODUCT_ID, coffee()]]),
    priceEntries: [],
    discountRules: [],
    ...overrides,
  };
}

function priceEntry(entry: {
  productId?: string;
  unitId: string | null;
  price: number;
  minQuantity?: number;
}): PriceEntry {
  return {
    productId: entry.productId ?? PRODUCT_ID,
    unitId: entry.unitId,
    price: new Decimal(entry.price),
    minQuantity: new Decimal(entry.minQuantity ?? 0),
  };
}

function rule(data: {
  id: string;
  ratePercent: number;
  kind?: DiscountKind;
  productId?: string;
  unitId?: string;
  minQuantity?: number;
  chainOrder?: number;
  logoDiscountCode?: string;
}): DiscountRuleData {
  return {
    id: data.id,
    kind: data.kind ?? 'LINE_VOLUME',
    productId: data.productId ?? null,
    unitId: data.unitId ?? null,
    minQuantity: new Decimal(data.minQuantity ?? 0),
    ratePercent: new Decimal(data.ratePercent),
    chainOrder: data.chainOrder ?? 1,
    logoDiscountCode: data.logoDiscountCode ?? null,
  };
}

/** noUncheckedIndexedAccess altinda testleri okunur tutar. */
function lineAt(order: PricedOrder, index = 0): PricedLine {
  const line = order.lines[index];

  if (!line) {
    throw new Error(`Beklenen satır bulunamadı: ${index}`);
  }

  return line;
}

describe('PricingService', () => {
  let service: PricingService;

  beforeEach(() => {
    service = new PricingService();
  });

  describe('birim fiyat çözümlemesi', () => {
    it('ana birim fiyatını çevrim katsayısıyla koli fiyatına dönüştürür', () => {
      const context = buildContext({
        priceEntries: [priceEntry({ unitId: null, price: 10 })],
      });

      const order = service.priceOrder(context, [
        { productId: PRODUCT_ID, unitId: KOLI_ID, quantity: new Decimal(2) },
      ]);

      // 10 TL/adet x 36 adet = 360 TL/koli
      expect(lineAt(order).unitPrice.toString()).toBe('360');
      expect(order.grossTotal.toString()).toBe('720');
    });

    it('birime doğrudan tanımlı fiyat, ana birimden türetilene göre önceliklidir', () => {
      const context = buildContext({
        priceEntries: [
          priceEntry({ unitId: null, price: 10 }),
          priceEntry({ unitId: KOLI_ID, price: 340 }),
        ],
      });

      const order = service.priceOrder(context, [
        { productId: PRODUCT_ID, unitId: KOLI_ID, quantity: new Decimal(1) },
      ]);

      expect(lineAt(order).unitPrice.toString()).toBe('340');
    });

    it('kademeli fiyatta miktarı karşılayan en yüksek eşik geçerlidir', () => {
      const context = buildContext({
        priceEntries: [
          priceEntry({ unitId: KOLI_ID, price: 360, minQuantity: 0 }),
          priceEntry({ unitId: KOLI_ID, price: 345, minQuantity: 10 }),
          priceEntry({ unitId: KOLI_ID, price: 330, minQuantity: 50 }),
        ],
      });

      const order = service.priceOrder(context, [
        { productId: PRODUCT_ID, unitId: KOLI_ID, quantity: new Decimal(12) },
      ]);

      expect(lineAt(order).unitPrice.toString()).toBe('345');
    });

    it('ana birim kademesini koli miktarı üzerinden değil, çevrilmiş miktar üzerinden değerlendirir', () => {
      const context = buildContext({
        priceEntries: [
          priceEntry({ unitId: null, price: 10, minQuantity: 0 }),
          priceEntry({ unitId: null, price: 9, minQuantity: 100 }),
        ],
      });

      // 3 koli = 108 adet -> 100 adet kademesini tetikler
      const order = service.priceOrder(context, [
        { productId: PRODUCT_ID, unitId: KOLI_ID, quantity: new Decimal(3) },
      ]);

      expect(lineAt(order).unitPrice.toString()).toBe('324');
    });

    it('fiyat listesi KDV dahil ise brüt fiyattan vergiyi ayrıştırır', () => {
      const context = buildContext({
        vatIncluded: true,
        priceEntries: [priceEntry({ unitId: ADET_ID, price: 120 })],
      });

      const order = service.priceOrder(context, [
        { productId: PRODUCT_ID, unitId: ADET_ID, quantity: new Decimal(1) },
      ]);

      // 120 / 1.20 = 100 (vergi hariç), KDV tekrar eklenince 120'ye döner
      expect(lineAt(order).unitPrice.toString()).toBe('100');
      expect(order.grandTotal.toString()).toBe('120');
    });

    it('fiyat tanımlı değilse hata fırlatır — sıfır fiyatla sipariş geçmez', () => {
      const context = buildContext();

      expect(() =>
        service.priceOrder(context, [
          { productId: PRODUCT_ID, unitId: KOLI_ID, quantity: new Decimal(1) },
        ]),
      ).toThrow(/fiyat tanımlı değil/i);
    });
  });

  describe('iskontolar', () => {
    it('hacim iskontosunda satıra tek kademe uygular, ürüne özel kural geneli eler', () => {
      const context = buildContext({
        priceEntries: [priceEntry({ unitId: KOLI_ID, price: 100 })],
        discountRules: [
          rule({ id: 'genel', ratePercent: 3, minQuantity: 5 }),
          rule({ id: 'urune-ozel', ratePercent: 8, productId: PRODUCT_ID, minQuantity: 5 }),
        ],
      });

      const line = lineAt(
        service.priceOrder(context, [
          { productId: PRODUCT_ID, unitId: KOLI_ID, quantity: new Decimal(10) },
        ]),
      );

      expect(line.appliedDiscounts).toHaveLength(1);
      expect(line.appliedDiscounts[0]?.ratePercent).toBe(8);
      expect(line.discountTotal.toString()).toBe('80');
      expect(line.netAmount.toString()).toBe('920');
    });

    it('eşiği karşılamayan hacim iskontosunu uygulamaz', () => {
      const context = buildContext({
        priceEntries: [priceEntry({ unitId: KOLI_ID, price: 100 })],
        discountRules: [rule({ id: 'hacim', ratePercent: 8, unitId: KOLI_ID, minQuantity: 10 })],
      });

      const line = lineAt(
        service.priceOrder(context, [
          { productId: PRODUCT_ID, unitId: KOLI_ID, quantity: new Decimal(9) },
        ]),
      );

      expect(line.appliedDiscounts).toHaveLength(0);
      expect(line.discountTotal.toString()).toBe('0');
    });

    it('zincirli dip iskontoyu sırayla ve kalan tutar üzerinden uygular', () => {
      const context = buildContext({
        priceEntries: [priceEntry({ unitId: ADET_ID, price: 1000 })],
        discountRules: [
          rule({ id: 'z2', kind: 'FOOTER_CHAIN', ratePercent: 5, chainOrder: 2 }),
          rule({ id: 'z1', kind: 'FOOTER_CHAIN', ratePercent: 10, chainOrder: 1 }),
        ],
      });

      const line = lineAt(
        service.priceOrder(context, [
          { productId: PRODUCT_ID, unitId: ADET_ID, quantity: new Decimal(1) },
        ]),
      );

      // 1000 -> %10 = 100 -> kalan 900 -> %5 = 45. Toplam 145 (155 DEĞİL).
      expect(line.appliedDiscounts.map((d) => d.ratePercent)).toEqual([10, 5]);
      expect(line.appliedDiscounts.map((d) => d.amount)).toEqual([100, 45]);
      expect(line.discountTotal.toString()).toBe('145');
      expect(line.netAmount.toString()).toBe('855');
    });

    it('hacim iskontosunu zincirli iskontodan önce uygular', () => {
      const context = buildContext({
        priceEntries: [priceEntry({ unitId: ADET_ID, price: 100 })],
        discountRules: [
          rule({ id: 'hacim', ratePercent: 10, minQuantity: 10 }),
          rule({ id: 'dip', kind: 'FOOTER_CHAIN', ratePercent: 10, chainOrder: 1 }),
        ],
      });

      const line = lineAt(
        service.priceOrder(context, [
          { productId: PRODUCT_ID, unitId: ADET_ID, quantity: new Decimal(10) },
        ]),
      );

      // 1000 -> hacim %10 = 100 -> kalan 900 -> dip %10 = 90
      expect(line.appliedDiscounts.map((d) => d.kind)).toEqual(['LINE_VOLUME', 'FOOTER_CHAIN']);
      expect(line.discountTotal.toString()).toBe('190');
      expect(line.netAmount.toString()).toBe('810');
    });

    it('iskonto dökümünde Logo indirim kartı kodunu taşır', () => {
      const context = buildContext({
        priceEntries: [priceEntry({ unitId: ADET_ID, price: 100 })],
        discountRules: [
          rule({ id: 'dip', kind: 'FOOTER_CHAIN', ratePercent: 10, logoDiscountCode: 'IND-01' }),
        ],
      });

      const line = lineAt(
        service.priceOrder(context, [
          { productId: PRODUCT_ID, unitId: ADET_ID, quantity: new Decimal(1) },
        ]),
      );

      expect(line.appliedDiscounts[0]?.logoDiscountCode).toBe('IND-01');
    });
  });

  describe('vergi ve toplamlar', () => {
    it('vergiyi iskontodan SONRAKİ net tutar üzerinden hesaplar', () => {
      const context = buildContext({
        priceEntries: [priceEntry({ unitId: ADET_ID, price: 1000 })],
        discountRules: [rule({ id: 'dip', kind: 'FOOTER_CHAIN', ratePercent: 10 })],
      });

      const line = lineAt(
        service.priceOrder(context, [
          { productId: PRODUCT_ID, unitId: ADET_ID, quantity: new Decimal(1) },
        ]),
      );

      expect(line.netAmount.toString()).toBe('900');
      expect(line.vatAmount.toString()).toBe('180');
      expect(line.lineTotal.toString()).toBe('1080');
    });

    it('belge toplamı satır toplamlarının birebir toplamıdır', () => {
      const second = coffee({ id: OTHER_PRODUCT_ID, vatRate: 10 });
      const context = buildContext({
        products: new Map([
          [PRODUCT_ID, coffee()],
          [second.id, second],
        ]),
        priceEntries: [
          priceEntry({ unitId: ADET_ID, price: 33.335 }),
          priceEntry({ productId: second.id, unitId: null, price: 12.005 }),
        ],
      });

      const order = service.priceOrder(context, [
        { productId: PRODUCT_ID, unitId: ADET_ID, quantity: new Decimal(3) },
        { productId: second.id, unitId: ADET_ID, quantity: new Decimal(7) },
      ]);

      const sum = (pick: (line: PricedLine) => Decimal) =>
        order.lines.reduce((acc, line) => acc.plus(pick(line)), new Decimal(0)).toString();

      expect(order.grossTotal.toString()).toBe(sum((l) => l.grossAmount));
      expect(order.netTotal.toString()).toBe(sum((l) => l.netAmount));
      expect(order.vatTotal.toString()).toBe(sum((l) => l.vatAmount));
      expect(order.grandTotal.toString()).toBe(sum((l) => l.lineTotal));
      expect(order.grandTotal.toString()).toBe(order.netTotal.plus(order.vatTotal).toString());
    });
  });

  describe('satır birleştirme', () => {
    it('aynı ürün+birim satırlarını toplar — eşik bölünmesini engeller', () => {
      const context = buildContext({
        priceEntries: [priceEntry({ unitId: KOLI_ID, price: 100 })],
        discountRules: [rule({ id: 'hacim', ratePercent: 10, unitId: KOLI_ID, minQuantity: 12 })],
      });

      const order = service.priceOrder(context, [
        { productId: PRODUCT_ID, unitId: KOLI_ID, quantity: new Decimal(6) },
        { productId: PRODUCT_ID, unitId: KOLI_ID, quantity: new Decimal(6) },
      ]);

      expect(order.lines).toHaveLength(1);
      expect(lineAt(order).quantity.toString()).toBe('12');
      expect(lineAt(order).appliedDiscounts).toHaveLength(1);
      expect(lineAt(order).discountTotal.toString()).toBe('120');
    });

    it('farklı birimdeki satırları ayrı tutar', () => {
      const context = buildContext({
        priceEntries: [priceEntry({ unitId: null, price: 10 })],
      });

      const order = service.priceOrder(context, [
        { productId: PRODUCT_ID, unitId: KOLI_ID, quantity: new Decimal(1) },
        { productId: PRODUCT_ID, unitId: ADET_ID, quantity: new Decimal(5) },
      ]);

      expect(order.lines).toHaveLength(2);
      expect(lineAt(order, 0).baseQuantity.toString()).toBe('36');
      expect(lineAt(order, 1).baseQuantity.toString()).toBe('5');
    });
  });

  it('katalogda bulunmayan ürün için sipariş almaz', () => {
    expect(() =>
      service.priceOrder(buildContext(), [
        {
          productId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          unitId: ADET_ID,
          quantity: new Decimal(1),
        },
      ]),
    ).toThrow();
  });
});
