/**
 * ToptanPortal - Rutin Siparis Sablonlari
 *
 * "10 Saniye Kurali"nin dayanagi: her hafta ayni 40 kalemi siparis eden kafe,
 * urunleri tek tek aramak zorunda kalmamalidir. Sablon sepete uygulanir,
 * miktarlar gozden gecirilir, siparis verilir.
 *
 * Sablon uygulanirken stokta olmayan satirlar SESSIZCE ATLANMAZ; atlananlar
 * gerekcesiyle birlikte raporlanir. Sessiz atlama, musterinin eksik siparis
 * verdigini fark etmemesine yol acar.
 */

import { Injectable } from '@nestjs/common';
import { Prisma, ProductStatus } from '@toptanportal/db';
import {
  ErrorCode,
  StockStatus,
  type ApplyTemplateResult,
  type OrderTemplateView,
  type UpsertOrderTemplateRequest,
} from '@toptanportal/contracts';

import { ApiException } from '../common/exceptions/api.exception';
import { PrismaService } from '../common/prisma/prisma.service';
import { CartService, type CartOwner } from '../cart/cart.service';
import { Decimal } from '../pricing/pricing.types';
import { StockService } from '../stock/stock.service';

const TEMPLATE_SELECT = {
  id: true,
  name: true,
  isShared: true,
  useCount: true,
  lastUsedAt: true,
  ownerUserId: true,
  owner: { select: { fullName: true } },
  items: {
    orderBy: { sortOrder: 'asc' },
    select: {
      productId: true,
      unitId: true,
      quantity: true,
      product: {
        select: {
          logoItemCode: true,
          name: true,
          imageUrl: true,
          status: true,
          units: { where: { isActive: true }, select: { id: true, code: true } },
        },
      },
    },
  },
} satisfies Prisma.OrderTemplateSelect;

type TemplateRow = Prisma.OrderTemplateGetPayload<{ select: typeof TEMPLATE_SELECT }>;

@Injectable()
export class OrderTemplateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cart: CartService,
    private readonly stock: StockService,
  ) {}

  /** Kullanicinin kendi sablonlari + isletmede paylasima acilmis sablonlar. */
  async list(owner: CartOwner): Promise<OrderTemplateView[]> {
    const rows = await this.prisma.orderTemplate.findMany({
      where: {
        companyId: owner.companyId,
        OR: [{ ownerUserId: owner.userId }, { isShared: true }],
      },
      select: TEMPLATE_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { lastUsedAt: 'desc' }, { name: 'asc' }],
    });

    const stockRows = await this.loadStockFor(owner, rows);

    return rows.map((row) => this.toView(row, stockRows));
  }

  async create(owner: CartOwner, request: UpsertOrderTemplateRequest): Promise<OrderTemplateView> {
    await this.assertItemsExist(owner, request.items);

    const created = await this.prisma.orderTemplate.create({
      data: {
        tenantId: owner.tenantId,
        companyId: owner.companyId,
        ownerUserId: owner.userId,
        name: request.name,
        isShared: request.isShared,
        items: {
          create: request.items.map((item, index) => ({
            productId: item.productId,
            unitId: item.unitId,
            quantity: new Decimal(item.quantity),
            sortOrder: index,
          })),
        },
      },
      select: TEMPLATE_SELECT,
    });

    return this.toView(created, await this.loadStockFor(owner, [created]));
  }

  /** Sablonu bastan yazar. Yalnizca sahibi degistirebilir. */
  async update(
    owner: CartOwner,
    templateId: string,
    request: UpsertOrderTemplateRequest,
  ): Promise<OrderTemplateView> {
    await this.assertOwnership(owner, templateId);
    await this.assertItemsExist(owner, request.items);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.orderTemplateItem.deleteMany({ where: { templateId } });

      return tx.orderTemplate.update({
        where: { id: templateId },
        data: {
          name: request.name,
          isShared: request.isShared,
          items: {
            create: request.items.map((item, index) => ({
              productId: item.productId,
              unitId: item.unitId,
              quantity: new Decimal(item.quantity),
              sortOrder: index,
            })),
          },
        },
        select: TEMPLATE_SELECT,
      });
    });

    return this.toView(updated, await this.loadStockFor(owner, [updated]));
  }

  async remove(owner: CartOwner, templateId: string): Promise<void> {
    await this.assertOwnership(owner, templateId);
    await this.prisma.orderTemplate.delete({ where: { id: templateId } });
  }

  /** Mevcut sepeti sablondaki satirlarla DEGISTIRIR (uzerine eklemez). */
  async applyToCart(owner: CartOwner, templateId: string): Promise<ApplyTemplateResult> {
    const template = await this.loadAccessible(owner, templateId);
    const stockRows = await this.loadStockFor(owner, [template]);

    const items: { productId: string; unitId: string; quantity: number }[] = [];
    const skipped: ApplyTemplateResult['skipped'] = [];

    for (const item of template.items) {
      if (item.product.status !== ProductStatus.PUBLISHED) {
        skipped.push({ productName: item.product.name, reason: 'UNAVAILABLE' });
        continue;
      }

      if (!item.product.units.some((unit) => unit.id === item.unitId)) {
        // Birim pasife alinmis - miktar cevrimi guvenilir degil, satir atlanir.
        skipped.push({ productName: item.product.name, reason: 'UNIT_CHANGED' });
        continue;
      }

      if (stockRows.get(item.productId)?.status === StockStatus.OUT_OF_STOCK) {
        skipped.push({ productName: item.product.name, reason: 'OUT_OF_STOCK' });
        continue;
      }

      items.push({
        productId: item.productId,
        unitId: item.unitId,
        quantity: new Decimal(item.quantity).toNumber(),
      });
    }

    const cart = await this.cart.replaceItems(owner, { items });

    await this.prisma.orderTemplate.update({
      where: { id: template.id },
      data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
    });

    return { cart, addedCount: items.length, skipped };
  }

  /** Mevcut sepetten sablon olusturur - "bu siparisi her hafta tekrarla". */
  async createFromCart(owner: CartOwner, name: string, isShared: boolean): Promise<OrderTemplateView> {
    const snapshot = await this.cart.buildSnapshot(owner);

    if (snapshot.lines.length === 0) {
      throw ApiException.unprocessable(
        ErrorCode.VALIDATION_FAILED,
        'Şablon oluşturmak için sepetinizde ürün olmalıdır.',
      );
    }

    return this.create(owner, {
      name,
      isShared,
      items: snapshot.lines.map((line) => ({
        productId: line.productId,
        unitId: line.unitId,
        quantity: line.quantity,
      })),
    });
  }

  private async loadAccessible(owner: CartOwner, templateId: string): Promise<TemplateRow> {
    const template = await this.prisma.orderTemplate.findFirst({
      where: {
        id: templateId,
        companyId: owner.companyId,
        OR: [{ ownerUserId: owner.userId }, { isShared: true }],
      },
      select: TEMPLATE_SELECT,
    });

    if (!template) {
      throw ApiException.notFound(ErrorCode.RESOURCE_NOT_FOUND, 'Şablon bulunamadı.');
    }

    return template;
  }

  /** Paylasilan sablonu baskasi DEGISTIREMEZ; yalnizca kullanabilir. */
  private async assertOwnership(owner: CartOwner, templateId: string): Promise<void> {
    const template = await this.prisma.orderTemplate.findFirst({
      where: { id: templateId, companyId: owner.companyId },
      select: { ownerUserId: true },
    });

    if (!template) {
      throw ApiException.notFound(ErrorCode.RESOURCE_NOT_FOUND, 'Şablon bulunamadı.');
    }

    if (template.ownerUserId !== owner.userId) {
      throw ApiException.forbidden(
        ErrorCode.FORBIDDEN,
        'Bu şablonu yalnızca oluşturan kullanıcı değiştirebilir.',
      );
    }
  }

  private async assertItemsExist(
    owner: CartOwner,
    items: readonly { productId: string; unitId: string }[],
  ): Promise<void> {
    const productIds = [...new Set(items.map((item) => item.productId))];
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds }, tenantId: owner.tenantId },
      select: { id: true, units: { select: { id: true } } },
    });

    const byId = new Map(products.map((product) => [product.id, product]));

    for (const item of items) {
      const product = byId.get(item.productId);

      if (!product || !product.units.some((unit) => unit.id === item.unitId)) {
        throw ApiException.unprocessable(
          ErrorCode.PRODUCT_UNAVAILABLE,
          'Şablondaki ürünlerden biri geçerli değil.',
        );
      }
    }
  }

  private async loadStockFor(owner: CartOwner, templates: readonly TemplateRow[]) {
    const productIds = [
      ...new Set(templates.flatMap((template) => template.items.map((item) => item.productId))),
    ];

    if (productIds.length === 0) {
      return new Map();
    }

    const warehouse = await this.stock.resolveWarehouse({
      tenantId: owner.tenantId,
      companyId: owner.companyId,
    });

    return this.stock.getFreeStock(productIds, warehouse.id);
  }

  private toView(
    row: TemplateRow,
    stockRows: Map<string, { status: StockStatus }>,
  ): OrderTemplateView {
    return {
      id: row.id,
      name: row.name,
      isShared: row.isShared,
      ownerName: row.owner.fullName,
      itemCount: row.items.length,
      useCount: row.useCount,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      items: row.items.map((item) => ({
        productId: item.productId,
        productName: item.product.name,
        productCode: item.product.logoItemCode,
        imageUrl: item.product.imageUrl,
        unitId: item.unitId,
        unitCode: item.product.units.find((unit) => unit.id === item.unitId)?.code ?? '-',
        quantity: new Decimal(item.quantity).toNumber(),
        stockStatus: stockRows.get(item.productId)?.status ?? StockStatus.OUT_OF_STOCK,
      })),
    };
  }
}
