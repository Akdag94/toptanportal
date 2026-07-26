/**
 * ToptanPortal - Sepet Servisi
 *
 * Sepet kullanici+cari basina TEKTIR. Cevrimdisi depo modunda iOS tarafinda
 * biriken satirlar baglanti gelince `replaceItems` ile toptan senkronize edilir;
 * bu yuzden "sepetin tamamini degistir" birinci sinif bir islemdir.
 *
 * Sepet gorunumu her cagrida YENIDEN fiyatlandirilir. Fiyat sepette saklanmaz:
 * saklanan fiyat, liste guncellendiginde sessizce eskir ve musteriye yanlis
 * tutar gosterir. Tek dogruluk kaynagi fiyat listesidir.
 */

import { Injectable } from '@nestjs/common';
import { Prisma, ProductStatus, type PrismaTransactionClient } from '@toptanportal/db';
import {
  ErrorCode,
  StockStatus,
  type CartItemInput,
  type CartLine,
  type CartView,
  type SetCartItemsRequest,
} from '@toptanportal/contracts';

import { ApiException } from '../common/exceptions/api.exception';
import { PrismaService } from '../common/prisma/prisma.service';
import { PricingContextService } from '../pricing/pricing-context.service';
import { PricingService } from '../pricing/pricing.service';
import { Decimal, type PricedLine, type PricedOrder } from '../pricing/pricing.types';
import { StockService, type FreeStockRow } from '../stock/stock.service';

export interface CartOwner {
  tenantId: string;
  companyId: string;
  userId: string;
  canSeePrices: boolean;
}

const CART_SELECT = {
  id: true,
  note: true,
  items: {
    select: {
      productId: true,
      unitId: true,
      quantity: true,
      note: true,
      product: {
        select: {
          id: true,
          logoItemCode: true,
          name: true,
          imageUrl: true,
          units: {
            where: { isActive: true },
            select: { id: true, code: true, name: true, conversionFactor: true },
          },
        },
      },
    },
    // Toplu senkronizasyonda tum satirlar ayni `addedAt` degerini alir; urun
    // adi ikincil siralama olmadan sepet her istekte farkli sirada gorunur.
    orderBy: [{ addedAt: 'asc' }, { product: { name: 'asc' } }],
  },
} satisfies Prisma.CartSelect;

type CartRow = Prisma.CartGetPayload<{ select: typeof CART_SELECT }>;
type CartItemRow = CartRow['items'][number];

/** Sepetin fiyatlanmis ve stokla eslestirilmis hali. Siparis akisi da bunu kullanir. */
export interface CartSnapshot {
  cartId: string;
  note: string | null;
  lines: CartLine[];
  /** Kor modda null - fiyat hic hesaplanmaz. */
  priced: PricedOrder | null;
  stockRows: Map<string, FreeStockRow>;
  warehouseId: string;
  hasStockIssue: boolean;
  /** Birimi pasife alindigi icin gorunumden dusen satirlar. */
  droppedLines: number;
}

@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly pricing: PricingService,
    private readonly pricingContext: PricingContextService,
  ) {}

  async getCart(owner: CartOwner): Promise<CartView> {
    return this.toView(owner, await this.buildSnapshot(owner));
  }

  /** Sepetin tamamini degistirir - cevrimdisi senkronizasyonun giris kapisi. */
  async replaceItems(owner: CartOwner, request: SetCartItemsRequest): Promise<CartView> {
    const items = this.mergeItems(request.items);
    await this.assertItemsOrderable(owner, items);

    const cart = await this.loadOrCreateCart(owner);

    await this.prisma.$transaction(async (tx) => {
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

      if (items.length > 0) {
        await tx.cartItem.createMany({
          data: items.map((item) => ({
            cartId: cart.id,
            productId: item.productId,
            unitId: item.unitId,
            quantity: new Decimal(item.quantity),
            note: item.note ?? null,
          })),
        });
      }

      await tx.cart.update({ where: { id: cart.id }, data: { note: request.note ?? null } });
    });

    return this.getCart(owner);
  }

  /** Tek satir ekler; ayni urun+birim zaten varsa miktari ARTIRIR. */
  async addItem(owner: CartOwner, item: CartItemInput): Promise<CartView> {
    await this.assertItemsOrderable(owner, [item]);

    const cart = await this.loadOrCreateCart(owner);

    await this.prisma.cartItem.upsert({
      where: {
        cartId_productId_unitId: {
          cartId: cart.id,
          productId: item.productId,
          unitId: item.unitId,
        },
      },
      create: {
        cartId: cart.id,
        productId: item.productId,
        unitId: item.unitId,
        quantity: new Decimal(item.quantity),
        note: item.note ?? null,
      },
      update: {
        quantity: { increment: new Decimal(item.quantity) },
        ...(item.note ? { note: item.note } : {}),
      },
    });

    return this.getCart(owner);
  }

  /** Miktari mutlak deger olarak ayarlar; sifir veya altinda satiri siler. */
  async setItemQuantity(
    owner: CartOwner,
    productId: string,
    unitId: string,
    quantity: number,
  ): Promise<CartView> {
    if (quantity <= 0) {
      return this.removeItem(owner, productId, unitId);
    }

    await this.assertItemsOrderable(owner, [{ productId, unitId, quantity }]);

    const cart = await this.loadOrCreateCart(owner);

    await this.prisma.cartItem.upsert({
      where: { cartId_productId_unitId: { cartId: cart.id, productId, unitId } },
      create: { cartId: cart.id, productId, unitId, quantity: new Decimal(quantity) },
      update: { quantity: new Decimal(quantity) },
    });

    return this.getCart(owner);
  }

  async removeItem(owner: CartOwner, productId: string, unitId: string): Promise<CartView> {
    const cart = await this.loadOrCreateCart(owner);

    await this.prisma.cartItem.deleteMany({ where: { cartId: cart.id, productId, unitId } });

    return this.getCart(owner);
  }

  async clear(owner: CartOwner): Promise<CartView> {
    const cart = await this.loadOrCreateCart(owner);

    await this.prisma.cartItem.deleteMany({ where: { cartId: cart.id } });

    return this.getCart(owner);
  }

  /** Siparis olusturulduktan sonra sepeti bosaltir (siparis islemi icinde). */
  async clearWithin(tx: PrismaTransactionClient, cartId: string): Promise<void> {
    await tx.cartItem.deleteMany({ where: { cartId } });
    await tx.cart.update({ where: { id: cartId }, data: { note: null } });
  }

  /**
   * Sepeti fiyatlandirir ve stok durumunu isler.
   * Siparis akisi da bunu kullanir; boylece ekranda gorunen ile Logo'ya giden
   * tutar ayni koddan cikar.
   */
  async buildSnapshot(
    owner: CartOwner,
    options: { forcePricing?: boolean } = {},
  ): Promise<CartSnapshot> {
    const cart = await this.loadOrCreateCart(owner);
    // Ayni urun+birim satirlari fiyatlandirmada birlestirildigi icin sepet
    // gorunumu de birlesik satirlar uzerinden kurulur.
    const items = this.mergeCartItems(cart.items);
    const productIds = [...new Set(items.map((item) => item.productId))];

    const warehouse = await this.stock.resolveWarehouse({
      tenantId: owner.tenantId,
      companyId: owner.companyId,
    });

    const [stockRows, priced] = await Promise.all([
      this.stock.getFreeStock(productIds, warehouse.id),
      this.priceItems(owner, items, options.forcePricing ?? false),
    ]);

    const pricedByKey = new Map(
      (priced?.lines ?? []).map((line) => [`${line.productId}:${line.unitId}`, line]),
    );

    const lines: CartLine[] = [];
    let hasStockIssue = false;
    let droppedLines = 0;

    for (const item of items) {
      const unit = item.product.units.find((u) => u.id === item.unitId);

      if (!unit) {
        // Birim pasife alinmis; satir gosterilemez ve siparise giremez.
        droppedLines += 1;
        continue;
      }

      const baseQuantity = item.quantity.times(unit.conversionFactor);
      const stock = stockRows.get(item.productId);
      const freeStock = stock?.freeStock ?? new Decimal(0);
      const exceedsStock = baseQuantity.greaterThan(freeStock);

      if (exceedsStock) hasStockIssue = true;

      const line: CartLine = {
        productId: item.productId,
        productCode: item.product.logoItemCode,
        productName: item.product.name,
        imageUrl: item.product.imageUrl,
        unitId: unit.id,
        unitCode: unit.code,
        unitName: unit.name,
        quantity: item.quantity.toNumber(),
        conversionFactor: unit.conversionFactor.toNumber(),
        baseQuantity: baseQuantity.toNumber(),
        stockStatus: stock?.status ?? StockStatus.OUT_OF_STOCK,
        exceedsStock,
        note: item.note,
      };

      const pricedLine = pricedByKey.get(`${item.productId}:${item.unitId}`);

      if (owner.canSeePrices && pricedLine) {
        this.attachAmounts(line, pricedLine);
      }

      lines.push(line);
    }

    return {
      cartId: cart.id,
      note: cart.note,
      lines,
      priced,
      stockRows,
      warehouseId: warehouse.id,
      hasStockIssue,
      droppedLines,
    };
  }

  toView(owner: CartOwner, snapshot: CartSnapshot): CartView {
    const view: CartView = {
      id: snapshot.cartId,
      companyId: owner.companyId,
      lines: snapshot.lines,
      lineCount: snapshot.lines.length,
      note: snapshot.note,
      blindOrderMode: !owner.canSeePrices,
      hasStockIssue: snapshot.hasStockIssue,
    };

    if (owner.canSeePrices && snapshot.priced) {
      view.grossTotal = snapshot.priced.grossTotal.toNumber();
      view.discountTotal = snapshot.priced.discountTotal.toNumber();
      view.netTotal = snapshot.priced.netTotal.toNumber();
      view.vatTotal = snapshot.priced.vatTotal.toNumber();
      view.grandTotal = snapshot.priced.grandTotal.toNumber();
      view.currency = snapshot.priced.currency;
      view.priceListName = snapshot.priced.priceListName;
    }

    return view;
  }

  private attachAmounts(line: CartLine, priced: PricedLine): void {
    line.unitPrice = priced.unitPrice.toNumber();
    line.grossAmount = priced.grossAmount.toNumber();
    line.discountTotal = priced.discountTotal.toNumber();
    line.netAmount = priced.netAmount.toNumber();
    line.vatRate = priced.vatRate.toNumber();
    line.vatAmount = priced.vatAmount.toNumber();
    line.lineTotal = priced.lineTotal.toNumber();
    line.appliedDiscounts = priced.appliedDiscounts;
  }

  /**
   * Kor moddaki kullaniciya sepet gorunumunde fiyat hesaplanmaz - deger uretilip
   * sonra gizlenmez, hic uretilmez.
   *
   * TEK ISTISNA `forcePricing`: siparis kesinlestirilirken tutarlar sunucuda
   * mutlaka hesaplanmalidir (belge, onay ve Logo fisi bunlara dayanir). Bu
   * durumda da degerler YANITA KONMAZ; yalnizca sunucu icinde kullanilir.
   */
  private async priceItems(
    owner: CartOwner,
    items: readonly CartItemRow[],
    forcePricing: boolean,
  ): Promise<PricedOrder | null> {
    if ((!owner.canSeePrices && !forcePricing) || items.length === 0) {
      return null;
    }

    const context = await this.pricingContext.load({
      tenantId: owner.tenantId,
      companyId: owner.companyId,
      productIds: items.map((item) => item.productId),
    });

    return this.pricing.priceOrder(
      context,
      items.map((item) => ({
        productId: item.productId,
        unitId: item.unitId,
        quantity: item.quantity,
        note: item.note,
      })),
    );
  }

  /**
   * Sepete konan urunun gercekten siparis edilebilir oldugunu dogrular.
   * Yayindan kaldirilmis urun veya pasif birim, sepete girmeden reddedilir -
   * musteri sepeti doldurup odeme adiminda surpriz yasamaz.
   */
  private async assertItemsOrderable(
    owner: CartOwner,
    items: readonly { productId: string; unitId: string; quantity: number }[],
  ): Promise<void> {
    if (items.length === 0) return;

    const productIds = [...new Set(items.map((item) => item.productId))];
    const products = await this.prisma.product.findMany({
      where: {
        id: { in: productIds },
        tenantId: owner.tenantId,
        status: ProductStatus.PUBLISHED,
      },
      select: {
        id: true,
        name: true,
        baseUnitCode: true,
        minOrderQuantity: true,
        maxOrderQuantity: true,
        units: { where: { isActive: true }, select: { id: true, conversionFactor: true } },
      },
    });

    const byId = new Map(products.map((product) => [product.id, product]));

    for (const item of items) {
      const product = byId.get(item.productId);

      if (!product) {
        throw ApiException.unprocessable(
          ErrorCode.PRODUCT_UNAVAILABLE,
          'Seçilen ürün artık satışta değil.',
        );
      }

      const unit = product.units.find((u) => u.id === item.unitId);

      if (!unit) {
        throw ApiException.unprocessable(
          ErrorCode.PRODUCT_UNAVAILABLE,
          `"${product.name}" ürünü için seçilen birim geçerli değil.`,
        );
      }

      // Asgari/azami miktar urun kartinda ANA birimde tanimlidir.
      const baseQuantity = new Decimal(item.quantity).times(unit.conversionFactor);
      const min = new Decimal(product.minOrderQuantity);
      const max = product.maxOrderQuantity === null ? null : new Decimal(product.maxOrderQuantity);

      if (min.greaterThan(0) && baseQuantity.lessThan(min)) {
        throw ApiException.unprocessable(
          ErrorCode.VALIDATION_FAILED,
          `"${product.name}" için asgari sipariş miktarı ${min.toString()} ${product.baseUnitCode}.`,
        );
      }

      if (max !== null && baseQuantity.greaterThan(max)) {
        throw ApiException.unprocessable(
          ErrorCode.VALIDATION_FAILED,
          `"${product.name}" için azami sipariş miktarı ${max.toString()} ${product.baseUnitCode}.`,
        );
      }
    }
  }

  private async loadOrCreateCart(owner: CartOwner): Promise<CartRow> {
    const existing = await this.prisma.cart.findUnique({
      where: { userId_companyId: { userId: owner.userId, companyId: owner.companyId } },
      select: CART_SELECT,
    });

    if (existing) return existing;

    return this.prisma.cart.create({
      data: {
        tenantId: owner.tenantId,
        companyId: owner.companyId,
        userId: owner.userId,
      },
      select: CART_SELECT,
    });
  }

  /** Ayni urun+birim ciftini toplar - cevrimdisi senkronizasyonda sik gorulur. */
  private mergeItems(items: readonly CartItemInput[]): CartItemInput[] {
    const merged = new Map<string, CartItemInput>();

    for (const item of items) {
      const key = `${item.productId}:${item.unitId}`;
      const existing = merged.get(key);

      if (existing) {
        existing.quantity += item.quantity;
        existing.note = existing.note ?? item.note;
      } else {
        merged.set(key, { ...item });
      }
    }

    return [...merged.values()];
  }

  private mergeCartItems(items: readonly CartItemRow[]): CartItemRow[] {
    const merged = new Map<string, CartItemRow>();

    for (const item of items) {
      const key = `${item.productId}:${item.unitId}`;
      const existing = merged.get(key);

      if (existing) {
        existing.quantity = existing.quantity.plus(item.quantity);
        existing.note = existing.note ?? item.note;
      } else {
        merged.set(key, { ...item });
      }
    }

    return [...merged.values()];
  }
}
