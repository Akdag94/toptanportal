/**
 * ToptanPortal - Katalog Uc Noktalari
 *
 * Fiyat gorunurlugu rol matrisinden okunur; istemcinin gonderdigi hicbir
 * parametre bunu degistiremez. Plasiyer bayi adina calisiyorsa (masquerading)
 * fiyatlar HEDEF carinin listesine gore hesaplanir - kendi gordugu fiyat degil,
 * bayinin gordugu fiyat gecerlidir.
 */

import { Controller, Get, Param, ParseUUIDPipe, Post, Query, Body } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  barcodeLookupSchema,
  canSeeFinancials,
  catalogQuerySchema,
  type BarcodeLookupRequest,
  type CatalogPage,
  type CatalogProduct,
  type CatalogQuery,
} from '@toptanportal/contracts';

import { CurrentUser, RateLimit, RequirePermissions } from '../common/decorators';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import { requireCompanyContext } from '../common/context/company-context';
import type { AuthenticatedPrincipal } from '../common/context/request-context';
import { CatalogService, type CatalogViewer } from './catalog.service';

@ApiTags('Katalog')
@Controller('catalog')
@RequirePermissions(Permission.CATALOG_VIEW)
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('products')
  @ApiOperation({ summary: 'Ürünleri listele' })
  async list(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query(zodBody(catalogQuerySchema)) query: CatalogQuery,
  ): Promise<CatalogPage> {
    return this.catalog.list(toViewer(principal), query);
  }

  @Get('products/:productId')
  @ApiOperation({ summary: 'Ürün ayrıntısı' })
  async detail(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
  ): Promise<CatalogProduct> {
    return this.catalog.getById(toViewer(principal), productId);
  }

  @Post('barcode')
  @RateLimit({ limit: 120, windowSeconds: 60, scope: 'USER' })
  @ApiOperation({ summary: 'Barkoddan ürün bul' })
  async barcode(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(barcodeLookupSchema)) body: BarcodeLookupRequest,
  ): Promise<{ product: CatalogProduct; matchedUnitCode: string | null }> {
    return this.catalog.findByBarcode(toViewer(principal), body.barcode);
  }
}

export function toViewer(principal: AuthenticatedPrincipal): CatalogViewer {
  return {
    tenantId: principal.tenantId,
    companyId: requireCompanyContext(principal),
    canSeePrices: canSeeFinancials(principal.role),
  };
}
