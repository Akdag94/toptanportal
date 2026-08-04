/**
 * ToptanPortal API - Fiyat Listeleri
 *
 * Liste TANIMI portalde acilmaz: hangi bayinin hangi listeden alacagi ticari
 * bir karardir ve Logo'da verilir. Liste SATIRI - yani fiyatin kendisi -
 * degistirilebilir ve degisiklik Logo'ya yazilir.
 *
 * Eski gerekce ("portalden degistirilen fiyati senkron geri alir") dogruydu ve
 * hala gecerlidir; cozum fiyati portalde tutmak degil, degisikligi Logo'ya
 * TASIMAKTIR. Senkron o degeri geri okudugunda iki taraf zaten aynidir.
 *
 * OKUMA ile YAZMA farkli yetki ister: `PRICE_LIST_MANAGE` listeyi gormeyi
 * acar, `PRICE_CHANGE` kesilecek faturayi degistirir.
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@toptanportal/db';
import {
  Permission,
  priceChangeSchema,
  priceListItemQuerySchema,
  type PriceChangeRequest,
  type PriceListItemPage,
  type PriceListItemQuery,
  type PriceListItemView,
  type PriceListView,
} from '@toptanportal/contracts';

import { CurrentUser, RateLimit, RequirePermissions } from '../common/decorators';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import { PrismaService } from '../common/prisma/prisma.service';
import type { AuthenticatedPrincipal } from '../common/context/request-context';
import { PriceChangeService } from './price-change.service';

@ApiTags('Fiyat Listeleri')
@Controller('price-lists')
@RequirePermissions(Permission.PRICE_LIST_MANAGE)
export class PriceListController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly priceChange: PriceChangeService,
  ) {}

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
        unitId: satir.unitId,
        unitCode: satir.unit?.code ?? null,
        price: satir.price.toNumber(),
        minQuantity: satir.minQuantity.toNumber(),
        validFrom: satir.validFrom?.toISOString() ?? null,
        validTo: satir.validTo?.toISOString() ?? null,
        logoWriteState: satir.logoWriteState,
        logoWriteError: satir.logoWriteError,
        lastSyncedAt: satir.logoSyncedAt?.toISOString() ?? null,
      })),
      totalCount: toplam,
      hasMore: query.offset + satirlar.length < toplam,
    };
  }

  /**
   * Tek bir fiyati degistirir ve Logo'ya yazilmak uzere kuyruga alir.
   *
   * TOPLU degisiklik ucu bilincli olarak yoktur: bir ekrandan yuzlerce fiyati
   * birden degistirmek, yanlis bir yuzdeyi tum katalogda uygulamayi bir tiklik
   * hale getirir ve geri alinmasi Logo'da elle duzeltme gerektirir. Toplu is
   * gerektiginde dogru arac Logo'nun kendi guncelleme ekranidir; oradan yapilan
   * degisiklik zaten senkronla portale gelir.
   *
   * Hiz siniri bu yuzden dardir: her cagri kesilecek bir faturayi degistirir.
   */
  @Post('items')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.PRICE_CHANGE)
  @RateLimit({ limit: 120, windowSeconds: 3600, scope: 'USER' })
  @ApiOperation({ summary: 'Fiyat değiştir (Logo’ya yazılır)' })
  change(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(priceChangeSchema)) body: PriceChangeRequest,
  ): Promise<PriceListItemView> {
    return this.priceChange.change(principal, body);
  }
}
