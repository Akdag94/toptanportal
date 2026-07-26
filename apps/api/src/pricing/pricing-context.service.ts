/**
 * ToptanPortal - Fiyatlandirma Baglami Yukleyicisi
 *
 * Motorun ihtiyac duydugu her seyi (urun, birim, fiyat kademesi, iskonto kurali)
 * TEK sorgu turu ile toplar ve saf hesap servisine devreder. Sepette 200 satir
 * olsa bile sabit sayida sorgu calisir - satir basina sorgu YOKTUR.
 *
 * Fiyat listesi secimi:
 *   1. Carinin Logo'da tanimli ozel listesi (companies.logoPriceListNo)
 *   2. Yoksa varsayilan liste (price_lists.isDefault)
 * Liste bulunamazsa baglam bos fiyatlarla doner; motor bunu PRICE_NOT_DEFINED
 * hatasina cevirir. Fiyati "0" varsaymak ticari olarak kabul edilemez.
 */

import { Injectable } from '@nestjs/common';
import { DiscountScope, ProductStatus, type Prisma } from '@toptanportal/db';
import { ErrorCode } from '@toptanportal/contracts';

import { ApiException } from '../common/exceptions/api.exception';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  Decimal,
  type DiscountKind,
  type DiscountRuleData,
  type PriceEntry,
  type PricingContext,
  type PricingProduct,
} from './pricing.types';

export interface LoadPricingContextParams {
  tenantId: string;
  companyId: string;
  productIds: readonly string[];
  /** Test edilebilirlik ve gecmise donuk fiyat ispati icin disaridan verilebilir. */
  at?: Date;
}

@Injectable()
export class PricingContextService {
  constructor(private readonly prisma: PrismaService) {}

  async load(params: LoadPricingContextParams): Promise<PricingContext> {
    const at = params.at ?? new Date();
    const productIds = [...new Set(params.productIds)];

    const company = await this.prisma.company.findFirst({
      where: { id: params.companyId, tenantId: params.tenantId },
      select: { id: true, logoPriceListNo: true },
    });

    if (!company) {
      throw ApiException.notFound(ErrorCode.RESOURCE_NOT_FOUND, 'İşletme bulunamadı.');
    }

    const priceList = await this.resolvePriceList(params.tenantId, company.logoPriceListNo, at);

    const [products, priceItems, discountRules] = await Promise.all([
      this.prisma.product.findMany({
        where: {
          tenantId: params.tenantId,
          id: { in: productIds },
          status: ProductStatus.PUBLISHED,
        },
        select: {
          id: true,
          logoItemCode: true,
          name: true,
          vatRate: true,
          baseUnitCode: true,
          units: {
            where: { isActive: true },
            select: {
              id: true,
              code: true,
              name: true,
              conversionFactor: true,
              isBaseUnit: true,
            },
            orderBy: { sortOrder: 'asc' },
          },
        },
      }),

      priceList
        ? this.prisma.priceListItem.findMany({
            where: {
              priceListId: priceList.id,
              productId: { in: productIds },
              AND: this.validityConditions<Prisma.PriceListItemWhereInput>(at),
            },
            select: { productId: true, unitId: true, price: true, minQuantity: true },
          })
        : Promise.resolve([]),

      this.prisma.discountRule.findMany({
        where: {
          tenantId: params.tenantId,
          isActive: true,
          OR: [
            { scope: DiscountScope.GLOBAL },
            { scope: DiscountScope.COMPANY, companyId: company.id },
            ...(priceList
              ? [{ scope: DiscountScope.PRICE_LIST, priceListId: priceList.id }]
              : []),
          ],
          AND: [
            ...this.validityConditions<Prisma.DiscountRuleWhereInput>(at),
            { OR: [{ productId: null }, { productId: { in: productIds } }] },
          ],
        },
        select: {
          id: true,
          kind: true,
          productId: true,
          unitId: true,
          minQuantity: true,
          ratePercent: true,
          chainOrder: true,
          logoDiscountCode: true,
        },
      }),
    ]);

    return {
      priceListId: priceList?.id ?? null,
      priceListName: priceList?.name ?? null,
      currency: priceList?.currency ?? 'TRY',
      vatIncluded: priceList?.vatIncluded ?? false,
      products: new Map(products.map((p) => [p.id, this.toPricingProduct(p)])),
      priceEntries: priceItems.map(
        (item): PriceEntry => ({
          productId: item.productId,
          unitId: item.unitId,
          price: new Decimal(item.price),
          minQuantity: new Decimal(item.minQuantity),
        }),
      ),
      discountRules: discountRules.map(
        (rule): DiscountRuleData => ({
          id: rule.id,
          kind: rule.kind as DiscountKind,
          productId: rule.productId,
          unitId: rule.unitId,
          minQuantity: new Decimal(rule.minQuantity),
          ratePercent: new Decimal(rule.ratePercent),
          chainOrder: rule.chainOrder,
          logoDiscountCode: rule.logoDiscountCode,
        }),
      ),
    };
  }

  private async resolvePriceList(tenantId: string, logoPriceListNo: number | null, at: Date) {
    const select = {
      id: true,
      name: true,
      currency: true,
      vatIncluded: true,
    } as const;

    if (logoPriceListNo !== null) {
      const specific = await this.prisma.priceList.findFirst({
        where: {
          tenantId,
          logoPriceListNo,
          isActive: true,
          AND: this.validityConditions<Prisma.PriceListWhereInput>(at),
        },
        select,
      });

      if (specific) return specific;
    }

    return this.prisma.priceList.findFirst({
      where: {
        tenantId,
        isDefault: true,
        isActive: true,
        AND: this.validityConditions<Prisma.PriceListWhereInput>(at),
      },
      select,
    });
  }

  /**
   * validFrom/validTo alanlarinda null "sinirsiz" anlamina gelir.
   * Uc modelde de ayni alan adlari bulundugu icin kosullar tek yerde uretilir;
   * cagiran taraf hangi modelin where tipini bekledigini acikca belirtir.
   */
  private validityConditions<T>(at: Date): T[] {
    return [
      { OR: [{ validFrom: null }, { validFrom: { lte: at } }] },
      { OR: [{ validTo: null }, { validTo: { gte: at } }] },
    ] as T[];
  }

  private toPricingProduct(product: {
    id: string;
    logoItemCode: string;
    name: string;
    vatRate: Prisma.Decimal;
    baseUnitCode: string;
    units: {
      id: string;
      code: string;
      name: string;
      conversionFactor: Prisma.Decimal;
      isBaseUnit: boolean;
    }[];
  }): PricingProduct {
    return {
      id: product.id,
      code: product.logoItemCode,
      name: product.name,
      vatRate: new Decimal(product.vatRate),
      baseUnitCode: product.baseUnitCode,
      units: product.units.map((unit) => ({
        id: unit.id,
        code: unit.code,
        name: unit.name,
        conversionFactor: new Decimal(unit.conversionFactor),
        isBaseUnit: unit.isBaseUnit,
      })),
    };
  }
}
