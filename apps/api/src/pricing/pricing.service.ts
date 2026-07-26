/**
 * ToptanPortal - Fiyatlandirma Motoru
 *
 * Bu servis SAF'tir: veritabanina dokunmaz, yalnizca kendisine verilen
 * `PricingContext` uzerinde hesap yapar. Boylece hem sepet onizlemesi hem de
 * siparis kesinlestirme ayni kodu calistirir ve ekranda gorunen tutar ile
 * Logo'ya yazilan tutarin ayrisması imkansiz hale gelir.
 *
 * TICARI KURALLAR
 *  1. Fiyat cozumlemesi: once secili birime dogrudan tanimli kademe aranir;
 *     yoksa ana birim fiyati cevrim katsayisiyla carpilir.
 *  2. Kademeli fiyat: miktari saglayan kademelerden EN YUKSEK `minQuantity`
 *     olani gecerlidir (Logo kademeli fiyat karti davranisi).
 *  3. Hacim iskontosu (LINE_VOLUME): satir basina TEK kademe uygulanir; urune
 *     ozel kural, genel kurali gecersiz kilar.
 *  4. Zincirli dip iskonto (FOOTER_CHAIN): `chainOrder` sirasiyla, her kademe
 *     bir oncekinden ARTA KALAN tutar uzerine uygulanir (%10 + %5 != %15).
 *  5. Vergi, iskontolar dusuldukten sonraki NET tutar uzerinden hesaplanir.
 *
 * YUVARLAMA: Tutarlar satir bazinda 2 haneye yuvarlanir, belge toplamlari bu
 * yuvarlanmis satirlarin toplamidir. Boylece belge her zaman kendi icinde
 * tutarlidir; toplamdan geriye dogru hesap yapan denetci fark bulamaz.
 */

import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@toptanportal/contracts';

import { ApiException } from '../common/exceptions/api.exception';
import {
  Decimal,
  money,
  price as priceScale,
  type AppliedDiscount,
  type DiscountRuleData,
  type PriceEntry,
  type PricedLine,
  type PricedOrder,
  type PricingContext,
  type PricingLineInput,
  type PricingProduct,
  type PricingUnit,
} from './pricing.types';

const ZERO = new Decimal(0);
const HUNDRED = new Decimal(100);

@Injectable()
export class PricingService {
  /**
   * Sepetin/siparisin tamamini fiyatlandirir.
   * Ayni urun+birim ciftinin birden fazla satirda gelmesi, kademe esiklerinin
   * bolunmesine yol acacagi icin satirlar once birlestirilir.
   */
  priceOrder(context: PricingContext, inputs: readonly PricingLineInput[]): PricedOrder {
    const lines = this.mergeInputs(inputs).map((input) => this.priceLine(context, input));

    let grossTotal = ZERO;
    let discountTotal = ZERO;
    let netTotal = ZERO;
    let vatTotal = ZERO;
    let grandTotal = ZERO;

    for (const line of lines) {
      grossTotal = grossTotal.plus(line.grossAmount);
      discountTotal = discountTotal.plus(line.discountTotal);
      netTotal = netTotal.plus(line.netAmount);
      vatTotal = vatTotal.plus(line.vatAmount);
      grandTotal = grandTotal.plus(line.lineTotal);
    }

    return {
      lines,
      grossTotal: money(grossTotal),
      discountTotal: money(discountTotal),
      netTotal: money(netTotal),
      vatTotal: money(vatTotal),
      grandTotal: money(grandTotal),
      currency: context.currency,
      priceListId: context.priceListId,
      priceListName: context.priceListName,
    };
  }

  /** Tek satirin fiyatlandirmasi. Katalog onizlemesi de bunu kullanabilir. */
  priceLine(context: PricingContext, input: PricingLineInput): PricedLine {
    const product = context.products.get(input.productId);

    if (!product) {
      throw ApiException.unprocessable(ErrorCode.PRODUCT_UNAVAILABLE);
    }

    const unit = product.units.find((u) => u.id === input.unitId);

    if (!unit) {
      throw ApiException.unprocessable(
        ErrorCode.PRODUCT_UNAVAILABLE,
        `"${product.name}" ürünü için seçilen birim geçerli değil.`,
      );
    }

    const quantity = input.quantity;
    const baseQuantity = quantity.times(unit.conversionFactor);
    const unitPrice = this.resolveUnitPrice(context, product, unit, quantity);

    if (unitPrice === null) {
      throw ApiException.unprocessable(
        ErrorCode.PRICE_NOT_DEFINED,
        `"${product.name}" ürünü için fiyat tanımlı değil.`,
      );
    }

    const grossAmount = money(unitPrice.times(quantity));
    const { discounts, discountTotal } = this.applyDiscounts(
      context,
      product,
      unit,
      quantity,
      baseQuantity,
      grossAmount,
    );

    const netAmount = money(grossAmount.minus(discountTotal));
    const vatAmount = money(netAmount.times(product.vatRate).dividedBy(HUNDRED));

    return {
      productId: product.id,
      productCode: product.code,
      productName: product.name,
      unitId: unit.id,
      unitCode: unit.code,
      unitName: unit.name,
      quantity,
      conversionFactor: unit.conversionFactor,
      baseQuantity,
      unitPrice,
      grossAmount,
      discountTotal,
      netAmount,
      vatRate: product.vatRate,
      vatAmount,
      lineTotal: money(netAmount.plus(vatAmount)),
      appliedDiscounts: discounts,
      note: input.note ?? null,
    };
  }

  /**
   * Secili birim icin vergi haric birim fiyati bulur. Fiyat tanimli degilse
   * null doner - cagiran taraf bunu satir hatasina cevirir.
   */
  resolveUnitPrice(
    context: PricingContext,
    product: PricingProduct,
    unit: PricingUnit,
    quantity: Decimal,
  ): Decimal | null {
    const entries = context.priceEntries.filter((e) => e.productId === product.id);

    // 1) Birime dogrudan tanimli kademe - miktar SECILI birimde karsilastirilir.
    const direct = this.bestTier(
      entries.filter((e) => e.unitId === unit.id),
      quantity,
    );

    if (direct) {
      return this.toNetPrice(direct.price, context, product);
    }

    // 2) Ana birim fiyati - miktar ANA birime cevrilerek karsilastirilir.
    const baseUnit = product.units.find((u) => u.isBaseUnit);
    const baseQuantity = quantity.times(unit.conversionFactor);
    const base = this.bestTier(
      entries.filter((e) => e.unitId === null || (baseUnit ? e.unitId === baseUnit.id : false)),
      baseQuantity,
    );

    if (!base) {
      return null;
    }

    // Ana birim fiyati -> secili birim fiyati (1 koli = 36 adet ise x36)
    const converted = base.price.times(unit.conversionFactor);
    return this.toNetPrice(converted, context, product);
  }

  /**
   * Miktari karsilayan kademeler icinde en yuksek esikli olani secer.
   * Esitlikte dusuk fiyat kazanir - musteri lehine yorum.
   */
  private bestTier(entries: readonly PriceEntry[], quantity: Decimal): PriceEntry | null {
    let best: PriceEntry | null = null;

    for (const entry of entries) {
      if (entry.minQuantity.greaterThan(quantity)) continue;

      if (
        best === null ||
        entry.minQuantity.greaterThan(best.minQuantity) ||
        (entry.minQuantity.equals(best.minQuantity) && entry.price.lessThan(best.price))
      ) {
        best = entry;
      }
    }

    return best;
  }

  /** Fiyat listesi KDV dahil giriliyorsa brut fiyattan vergiyi ayristirir. */
  private toNetPrice(value: Decimal, context: PricingContext, product: PricingProduct): Decimal {
    if (!context.vatIncluded) {
      return priceScale(value);
    }

    const divisor = HUNDRED.plus(product.vatRate).dividedBy(HUNDRED);
    return priceScale(value.dividedBy(divisor));
  }

  /**
   * Once tek kademe hacim iskontosu, ardindan zincirli dip iskontolar.
   * Her adim bir onceki adimdan arta kalan tutar uzerinden hesaplanir.
   */
  private applyDiscounts(
    context: PricingContext,
    product: PricingProduct,
    unit: PricingUnit,
    quantity: Decimal,
    baseQuantity: Decimal,
    grossAmount: Decimal,
  ): { discounts: AppliedDiscount[]; discountTotal: Decimal } {
    const applicable = context.discountRules.filter((rule) =>
      this.ruleMatches(rule, product, unit, quantity, baseQuantity),
    );

    const discounts: AppliedDiscount[] = [];
    let remaining = grossAmount;

    const volume = this.bestVolumeRule(applicable.filter((r) => r.kind === 'LINE_VOLUME'));

    if (volume) {
      const amount = money(remaining.times(volume.ratePercent).dividedBy(HUNDRED));

      if (amount.greaterThan(ZERO)) {
        discounts.push(this.toAppliedDiscount(volume, amount));
        remaining = remaining.minus(amount);
      }
    }

    const chain = applicable
      .filter((r) => r.kind === 'FOOTER_CHAIN')
      .sort((a, b) => a.chainOrder - b.chainOrder || a.id.localeCompare(b.id));

    for (const rule of chain) {
      const amount = money(remaining.times(rule.ratePercent).dividedBy(HUNDRED));

      if (amount.lessThanOrEqualTo(ZERO)) continue;

      discounts.push(this.toAppliedDiscount(rule, amount));
      remaining = remaining.minus(amount);
    }

    return { discounts, discountTotal: money(grossAmount.minus(remaining)) };
  }

  /**
   * Kural bu satira uygulanir mi?
   * `unitId` dolu ise miktar o birimde, bos ise ANA birimde karsilastirilir.
   */
  private ruleMatches(
    rule: DiscountRuleData,
    product: PricingProduct,
    unit: PricingUnit,
    quantity: Decimal,
    baseQuantity: Decimal,
  ): boolean {
    if (rule.productId !== null && rule.productId !== product.id) return false;
    if (rule.unitId !== null && rule.unitId !== unit.id) return false;

    const comparable = rule.unitId !== null ? quantity : baseQuantity;
    return !rule.minQuantity.greaterThan(comparable);
  }

  /**
   * Hacim iskontosunda satira TEK kural uygulanir:
   * urune ozel kural genel kurali eler, ardindan en yuksek esik, sonra en
   * yuksek oran kazanir.
   */
  private bestVolumeRule(rules: readonly DiscountRuleData[]): DiscountRuleData | null {
    let best: DiscountRuleData | null = null;

    for (const rule of rules) {
      if (best === null) {
        best = rule;
        continue;
      }

      const specificityDelta = this.specificity(rule) - this.specificity(best);

      if (specificityDelta > 0) {
        best = rule;
        continue;
      }

      if (specificityDelta < 0) continue;

      if (
        rule.minQuantity.greaterThan(best.minQuantity) ||
        (rule.minQuantity.equals(best.minQuantity) && rule.ratePercent.greaterThan(best.ratePercent))
      ) {
        best = rule;
      }
    }

    return best;
  }

  /** Birim kurali > urun kurali > genel kural. */
  private specificity(rule: DiscountRuleData): number {
    return (rule.productId !== null ? 1 : 0) + (rule.unitId !== null ? 1 : 0);
  }

  private toAppliedDiscount(rule: DiscountRuleData, amount: Decimal): AppliedDiscount {
    return {
      kind: rule.kind,
      ratePercent: rule.ratePercent.toNumber(),
      amount: amount.toNumber(),
      chainOrder: rule.chainOrder,
      logoDiscountCode: rule.logoDiscountCode,
    };
  }

  /**
   * Ayni urun+birim satirlarini toplar. Cevrimdisi depo modunda ayni urun
   * birden fazla kez okutulabildigi icin bu birlestirme sarttir; aksi halde
   * 6+6 koli, 12 kolilik hacim iskontosu esigini tetiklemez.
   */
  private mergeInputs(inputs: readonly PricingLineInput[]): PricingLineInput[] {
    const merged = new Map<string, PricingLineInput>();

    for (const input of inputs) {
      const key = `${input.productId}:${input.unitId}`;
      const existing = merged.get(key);

      if (!existing) {
        merged.set(key, { ...input });
        continue;
      }

      existing.quantity = existing.quantity.plus(input.quantity);
      existing.note = existing.note ?? input.note ?? null;
    }

    return [...merged.values()];
  }
}
