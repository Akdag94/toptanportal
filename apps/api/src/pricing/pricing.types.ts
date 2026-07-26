import { Prisma } from '@toptanportal/db';

export type Decimal = Prisma.Decimal;
export const Decimal = Prisma.Decimal;

/** Ticari yuvarlama: yariyi yukari (TR muhasebe uygulamasi). */
export const ROUNDING_MODE = Prisma.Decimal.ROUND_HALF_UP;
export const MONEY_SCALE = 2;
export const QUANTITY_SCALE = 4;
/** Birim fiyat hassasiyeti - order_lines.unitPrice Decimal(18,6) ile ayni. */
export const PRICE_SCALE = 6;

export function money(value: Decimal): Decimal {
  return value.toDecimalPlaces(MONEY_SCALE, ROUNDING_MODE);
}

export function quantity(value: Decimal): Decimal {
  return value.toDecimalPlaces(QUANTITY_SCALE, ROUNDING_MODE);
}

export function price(value: Decimal): Decimal {
  return value.toDecimalPlaces(PRICE_SCALE, ROUNDING_MODE);
}

export interface PricingUnit {
  id: string;
  code: string;
  name: string;
  /** 1 bu birim = kac ana birim */
  conversionFactor: Decimal;
  isBaseUnit: boolean;
}

export interface PricingProduct {
  id: string;
  code: string;
  name: string;
  vatRate: Decimal;
  baseUnitCode: string;
  units: PricingUnit[];
}

/**
 * Fiyat listesi satiri.
 * `unitId` null ise fiyat ANA BIRIM icindir; diger birimlerin fiyati cevrim
 * katsayisiyla turetilir.
 */
export interface PriceEntry {
  productId: string;
  unitId: string | null;
  price: Decimal;
  minQuantity: Decimal;
}

export type DiscountKind = 'LINE_VOLUME' | 'FOOTER_CHAIN';

export interface DiscountRuleData {
  id: string;
  kind: DiscountKind;
  /** null ise tum urunlere uygulanir */
  productId: string | null;
  /** null ise tum birimlere uygulanir */
  unitId: string | null;
  minQuantity: Decimal;
  ratePercent: Decimal;
  chainOrder: number;
  logoDiscountCode: string | null;
}

export interface PricingContext {
  priceListId: string | null;
  priceListName: string | null;
  currency: string;
  /** Fiyatlar KDV dahil girilmisse brut fiyattan vergi ayristirilir. */
  vatIncluded: boolean;
  products: Map<string, PricingProduct>;
  priceEntries: PriceEntry[];
  discountRules: DiscountRuleData[];
}

export interface PricingLineInput {
  productId: string;
  unitId: string;
  /** Secilen birimdeki miktar */
  quantity: Decimal;
  note?: string | null;
}

export interface AppliedDiscount {
  kind: DiscountKind;
  ratePercent: number;
  amount: number;
  chainOrder: number;
  logoDiscountCode: string | null;
}

export interface PricedLine {
  productId: string;
  productCode: string;
  productName: string;
  unitId: string;
  unitCode: string;
  unitName: string;
  quantity: Decimal;
  conversionFactor: Decimal;
  baseQuantity: Decimal;
  unitPrice: Decimal;
  grossAmount: Decimal;
  discountTotal: Decimal;
  netAmount: Decimal;
  vatRate: Decimal;
  vatAmount: Decimal;
  lineTotal: Decimal;
  appliedDiscounts: AppliedDiscount[];
  note: string | null;
}

export interface PricedOrder {
  lines: PricedLine[];
  grossTotal: Decimal;
  discountTotal: Decimal;
  netTotal: Decimal;
  vatTotal: Decimal;
  grandTotal: Decimal;
  currency: string;
  priceListId: string | null;
  priceListName: string | null;
}
