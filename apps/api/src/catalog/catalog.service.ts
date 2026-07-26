/**
 * ToptanPortal - Katalog Servisi
 *
 * KOR SIPARIS MODU BURADA BASLAR. BlindOrderInterceptor son savunma hattidir;
 * asil kural sudur: yetkisi olmayan kullanici icin fiyat HIC HESAPLANMAZ ve
 * yanit nesnesine HIC KONMAZ. Suzgece guvenip veriyi uretmek, suzgecte acilacak
 * tek bir bosluk ile fiyat sizmasi demektir.
 *
 * Sayisal serbest stok da ayni sekilde gizlenir: barista "5 koli kaldi" bilgisini
 * gormez, yalnizca "Stokta Var / Kritik Stok / Tukendi" nitel durumunu gorur.
 * Depo kapasitesi rakip istihbarati degeri tasir.
 */

import { Injectable } from '@nestjs/common';
import { Prisma, ProductStatus } from '@toptanportal/db';
import {
  ErrorCode,
  type CatalogPage,
  type CatalogProduct,
  type CatalogQuery,
  type ProductUnitView,
} from '@toptanportal/contracts';

import { ApiException } from '../common/exceptions/api.exception';
import { PrismaService } from '../common/prisma/prisma.service';
import { PricingContextService } from '../pricing/pricing-context.service';
import { PricingService } from '../pricing/pricing.service';
import { Decimal, type PricingContext } from '../pricing/pricing.types';
import { StockService, type FreeStockRow } from '../stock/stock.service';

export interface CatalogViewer {
  tenantId: string;
  companyId: string;
  /** PRICE_VIEW yetkisi. Yoksa hicbir parasal deger uretilmez. */
  canSeePrices: boolean;
}

const PRODUCT_SELECT = {
  id: true,
  logoItemCode: true,
  name: true,
  brand: true,
  categoryPath: true,
  imageUrl: true,
  baseUnitCode: true,
  vatRate: true,
  minOrderQuantity: true,
  maxOrderQuantity: true,
  units: {
    where: { isActive: true },
    select: {
      id: true,
      code: true,
      name: true,
      conversionFactor: true,
      isBaseUnit: true,
      isDefaultForOrder: true,
    },
    orderBy: { sortOrder: 'asc' },
  },
} satisfies Prisma.ProductSelect;

type ProductRow = Prisma.ProductGetPayload<{ select: typeof PRODUCT_SELECT }>;

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly pricing: PricingService,
    private readonly pricingContext: PricingContextService,
  ) {}

  async list(viewer: CatalogViewer, query: CatalogQuery): Promise<CatalogPage> {
    const warehouse = await this.stock.resolveWarehouse({
      tenantId: viewer.tenantId,
      companyId: viewer.companyId,
    });
    const where = this.buildWhere(viewer.tenantId, warehouse.id, query);

    // Bir fazla kayit cekilir; donmezse son sayfadayiz demektir.
    const rows = await this.prisma.product.findMany({
      where,
      select: PRODUCT_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const items = await this.decorate(viewer, page, warehouse.id);

    // Kaba SQL suzgeci rezervleri hesaba katamaz; serbest stok sifirin altina
    // dusmus urunler burada elenir. Imlec ham sayfadan uretildigi icin bu
    // eleme sayfalamayi bozmaz, yalnizca sayfayi kisaltir.
    const visible = query.inStockOnly
      ? items.filter((item) => item.stockStatus !== 'OUT_OF_STOCK')
      : items;

    return {
      items: visible,
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      blindOrderMode: !viewer.canSeePrices,
    };
  }

  async getById(viewer: CatalogViewer, productId: string): Promise<CatalogProduct> {
    const row = await this.prisma.product.findFirst({
      where: { id: productId, tenantId: viewer.tenantId, status: ProductStatus.PUBLISHED },
      select: PRODUCT_SELECT,
    });

    if (!row) {
      throw ApiException.notFound(ErrorCode.RESOURCE_NOT_FOUND, 'Ürün bulunamadı.');
    }

    const [item] = await this.decorate(viewer, [row]);

    if (!item) {
      throw ApiException.notFound(ErrorCode.RESOURCE_NOT_FOUND, 'Ürün bulunamadı.');
    }

    return item;
  }

  /**
   * Barkod okutma - depoda telefonla urun aramanin en hizli yolu.
   * Barkod hangi birime aitse (koli barkodu / adet barkodu) o birim varsayilan
   * secili gelir; depocu birim secmekle ugrasmaz.
   */
  async findByBarcode(
    viewer: CatalogViewer,
    barcode: string,
  ): Promise<{ product: CatalogProduct; matchedUnitCode: string | null }> {
    const match = await this.prisma.productBarcode.findFirst({
      where: {
        barcode,
        product: { tenantId: viewer.tenantId, status: ProductStatus.PUBLISHED },
      },
      select: { unitCode: true, product: { select: PRODUCT_SELECT } },
    });

    if (!match) {
      throw ApiException.notFound(
        ErrorCode.RESOURCE_NOT_FOUND,
        'Bu barkoda ait ürün bulunamadı.',
      );
    }

    const [product] = await this.decorate(viewer, [match.product]);

    if (!product) {
      throw ApiException.notFound(ErrorCode.RESOURCE_NOT_FOUND, 'Ürün bulunamadı.');
    }

    return { product, matchedUnitCode: match.unitCode };
  }

  private buildWhere(
    tenantId: string,
    warehouseId: string,
    query: CatalogQuery,
  ): Prisma.ProductWhereInput {
    const where: Prisma.ProductWhereInput = {
      tenantId,
      status: ProductStatus.PUBLISHED,
    };

    if (query.inStockOnly) {
      // Kolon-kolon karsilastirma (onHand - reserved > 0) Prisma filtresiyle
      // ifade edilemez; burada kaba eleme yapilir, kesin eleme sayfa
      // zenginlestirildikten sonra uygulanir.
      where.stockSnapshots = { some: { warehouseId, onHand: { gt: 0 } } };
    }

    if (query.brand) {
      where.brand = query.brand;
    }

    if (query.category) {
      // Kategori yolu hiyerarsiktir: "Icecek/Kahve" secildiginde alt kirilimlar
      // da gelir.
      where.categoryPath = { startsWith: query.category };
    }

    if (query.q) {
      const term = query.q;
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { logoItemCode: { contains: term, mode: 'insensitive' } },
        { brand: { contains: term, mode: 'insensitive' } },
        { barcodes: { some: { barcode: { contains: term, mode: 'insensitive' } } } },
      ];
    }

    return where;
  }

  /**
   * Urun satirlarini stok durumu ve (yetki varsa) fiyatla zenginlestirir.
   * Fiyat ve stok TEK sorguda toplanir; urun basina sorgu yoktur.
   */
  private async decorate(
    viewer: CatalogViewer,
    rows: readonly ProductRow[],
    warehouseId?: string,
  ): Promise<CatalogProduct[]> {
    if (rows.length === 0) return [];

    const productIds = rows.map((row) => row.id);
    const resolvedWarehouseId =
      warehouseId ??
      (
        await this.stock.resolveWarehouse({
          tenantId: viewer.tenantId,
          companyId: viewer.companyId,
        })
      ).id;

    const [stockRows, pricingContext] = await Promise.all([
      this.stock.getFreeStock(productIds, resolvedWarehouseId),
      viewer.canSeePrices
        ? this.pricingContext.load({
            tenantId: viewer.tenantId,
            companyId: viewer.companyId,
            productIds,
          })
        : Promise.resolve(null),
    ]);

    return rows.map((row) => this.toCatalogProduct(viewer, row, stockRows, pricingContext));
  }

  private toCatalogProduct(
    viewer: CatalogViewer,
    row: ProductRow,
    stockRows: Map<string, FreeStockRow>,
    pricingContext: PricingContext | null,
  ): CatalogProduct {
    const stock = stockRows.get(row.id);
    const units = row.units.map((unit) =>
      this.toUnitView(row.id, unit, viewer, pricingContext),
    );
    const defaultUnit = units.find((u) => u.isDefaultForOrder) ?? units[0];

    const product: CatalogProduct = {
      id: row.id,
      code: row.logoItemCode,
      name: row.name,
      brand: row.brand,
      categoryPath: row.categoryPath,
      imageUrl: row.imageUrl,
      baseUnitCode: row.baseUnitCode,
      units,
      stockStatus: stock?.status ?? 'OUT_OF_STOCK',
      minOrderQuantity: new Decimal(row.minOrderQuantity).toNumber(),
      maxOrderQuantity:
        row.maxOrderQuantity === null ? null : new Decimal(row.maxOrderQuantity).toNumber(),
    };

    // --- Buradan asagisi YALNIZCA yetkili kullanici icin uretilir ---
    if (!viewer.canSeePrices) {
      return product;
    }

    product.freeStock = stock ? stock.freeStock.toNumber() : 0;
    product.vatRate = new Decimal(row.vatRate).toNumber();

    if (defaultUnit?.unitPrice !== undefined) {
      product.price = defaultUnit.unitPrice;
    }

    return product;
  }

  private toUnitView(
    productId: string,
    unit: ProductRow['units'][number],
    viewer: CatalogViewer,
    pricingContext: PricingContext | null,
  ): ProductUnitView {
    const view: ProductUnitView = {
      id: unit.id,
      code: unit.code,
      name: unit.name,
      conversionFactor: new Decimal(unit.conversionFactor).toNumber(),
      isBaseUnit: unit.isBaseUnit,
      isDefaultForOrder: unit.isDefaultForOrder,
    };

    if (!viewer.canSeePrices || !pricingContext) {
      return view;
    }

    const product = pricingContext.products.get(productId);
    const pricingUnit = product?.units.find((u) => u.id === unit.id);

    if (!product || !pricingUnit) {
      return view;
    }

    // Katalogda 1 birimlik liste fiyati gosterilir; hacim iskontolari sepette
    // miktar belli olunca uygulanir.
    const unitPrice = this.pricing.resolveUnitPrice(
      pricingContext,
      product,
      pricingUnit,
      new Decimal(1),
    );

    if (unitPrice !== null) {
      view.unitPrice = unitPrice.toNumber();
    }

    return view;
  }
}
