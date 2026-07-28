/**
 * ToptanPortal API - Fiyat Listeleri (salt okunur)
 *
 * Fiyatlar Logo'dan senkronlanir; portal onlari DEGISTIRMEZ. Bu denetleyicide
 * yazma ucu bilincli olarak yoktur: fiyati portalden degistirmek, iki sistem
 * arasinda hangisinin dogru oldugu belirsiz bir alan yaratir ve bir sonraki
 * senkron o degisikligi sessizce geri alir - kullanici da neden geri
 * alindigini asla anlamaz.
 *
 * Bu ekranin isi FIYATI DEGISTIRMEK degil, "bu bayi bu urunu kacdan aliyor"
 * sorusunu cevaplamaktir.
 */

import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@toptanportal/db';
import {
  Permission,
  priceListItemQuerySchema,
  type PriceListItemPage,
  type PriceListItemQuery,
  type PriceListView,
} from '@toptanportal/contracts';

import { CurrentUser, RequirePermissions } from '../common/decorators';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import { PrismaService } from '../common/prisma/prisma.service';
import type { AuthenticatedPrincipal } from '../common/context/request-context';

@ApiTags('Fiyat Listeleri')
@Controller('price-lists')
@RequirePermissions(Permission.PRICE_LIST_MANAGE)
export class PriceListController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Fiyat listeleri' })
  async list(@CurrentUser() principal: AuthenticatedPrincipal): Promise<PriceListView[]> {
    const listeler = await this.prisma.priceList.findMany({
      where: { tenantId: principal.tenantId },
      include: { _count: { select: { items: true } } },
      orderBy: [{ isDefault: 'desc' }, { logoPriceListNo: 'asc' }],
    });

    /* Bayi sayisi tek sorguda gruplanir: liste basina sorgu, on listede on
       gidis-donus demektir ve bu ekran her acilista cagrilir. */
    const bayiSayilari = await this.prisma.company.groupBy({
      by: ['logoPriceListNo'],
      where: { tenantId: principal.tenantId, logoPriceListNo: { not: null } },
      _count: { _all: true },
    });

    const sayiHaritasi = new Map(
      bayiSayilari
        .filter((satir) => satir.logoPriceListNo !== null)
        .map((satir) => [satir.logoPriceListNo as number, satir._count._all]),
    );

    return listeler.map((liste) => ({
      id: liste.id,
      logoPriceListNo: liste.logoPriceListNo,
      name: liste.name,
      currency: liste.currency,
      vatIncluded: liste.vatIncluded,
      isDefault: liste.isDefault,
      isActive: liste.isActive,
      itemCount: liste._count.items,
      companyCount: sayiHaritasi.get(liste.logoPriceListNo) ?? 0,
      lastSyncedAt: liste.logoSyncedAt?.toISOString() ?? null,
    }));
  }

  @Get('items')
  @ApiOperation({ summary: 'Fiyat listesi satırları' })
  async items(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query(zodBody(priceListItemQuerySchema)) query: PriceListItemQuery,
  ): Promise<PriceListItemPage> {
    const where: Prisma.PriceListItemWhereInput = {
      priceListId: query.priceListId,
      /* Kiraci denetimi liste uzerinden yapilir: satirin kendisinde tenantId
         yoktur ve baska bir kiracinin liste kimligini gonderen bir istek,
         bu kosul olmadan o kiracinin fiyatlarini okurdu. */
      priceList: { tenantId: principal.tenantId },
      ...(query.q
        ? {
            product: {
              OR: [
                { name: { contains: query.q, mode: 'insensitive' } },
                { logoItemCode: { contains: query.q, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    };

    const [satirlar, toplam] = await Promise.all([
      this.prisma.priceListItem.findMany({
        where,
        include: {
          product: { select: { id: true, logoItemCode: true, name: true } },
          unit: { select: { code: true } },
        },
        orderBy: [{ product: { name: 'asc' } }, { minQuantity: 'asc' }],
        skip: query.offset,
        take: query.limit,
      }),
      this.prisma.priceListItem.count({ where }),
    ]);

    return {
      items: satirlar.map((satir) => ({
        id: satir.id,
        productId: satir.productId,
        productCode: satir.product.logoItemCode,
        productName: satir.product.name,
        unitCode: satir.unit?.code ?? null,
        price: satir.price.toNumber(),
        minQuantity: satir.minQuantity.toNumber(),
        validFrom: satir.validFrom?.toISOString() ?? null,
        validTo: satir.validTo?.toISOString() ?? null,
        lastSyncedAt: satir.logoSyncedAt?.toISOString() ?? null,
      })),
      totalCount: toplam,
      hasMore: query.offset + satirlar.length < toplam,
    };
  }
}
