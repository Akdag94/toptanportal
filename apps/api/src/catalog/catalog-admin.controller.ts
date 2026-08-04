/**
 * ToptanPortal API - Katalog Yonetimi Uc Noktalari
 *
 * Katalogu OKUYAN uclardan (`/catalog/*`) ayri bir denetleyicide durur.
 * Sebebi yetkidir: okuma `CATALOG_VIEW` ile herkese acikken, buradaki her uc
 * Logo'da kalici bir kayit dogurur ve `CATALOG_MANAGE` ister. Iki farkli
 * yetkiyi ayni denetleyicide tasimak, uc basina yetki ekleme aliskanligi
 * yaratir - ve bir gun eklenmeyen yetki, katalogu herkese acik yazilabilir
 * hale getirir.
 */

import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  adminProductQuerySchema,
  productCreateSchema,
  productUpdateSchema,
  type AdminProductPage,
  type AdminProductQuery,
  type AdminProductView,
  type ProductCreateRequest,
  type ProductUpdateRequest,
} from '@toptanportal/contracts';

import { CurrentUser, RateLimit, RequirePermissions } from '../common/decorators';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import type { AuthenticatedPrincipal } from '../common/context/request-context';
import { CatalogAdminService } from './catalog-admin.service';

@ApiTags('Katalog Yönetimi')
@Controller('catalog-admin')
@RequirePermissions(Permission.CATALOG_MANAGE)
export class CatalogAdminController {
  constructor(private readonly catalog: CatalogAdminService) {}

  @Get('products')
  @ApiOperation({ summary: 'Yönetim listesi — köken ve Logo yazma durumuyla' })
  list(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query(zodBody(adminProductQuerySchema)) query: AdminProductQuery,
  ): Promise<AdminProductPage> {
    return this.catalog.list(principal, query);
  }

  /**
   * Yeni stok karti acar.
   *
   * Hiz siniri dardir: her cagri Logo'da KALICI bir kart doguracak bir olay
   * kuyruga koyar ve kartin kodu sonradan degistirilemez. Dongu hatasiyla
   * acilan yuz kart, Logo'da elle temizlenmesi gereken yuz satirdir.
   */
  @Post('products')
  @RateLimit({ limit: 60, windowSeconds: 3600, scope: 'USER' })
  @ApiOperation({ summary: 'Ürün kartı aç (Logo’ya yazılır)' })
  create(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(productCreateSchema)) body: ProductCreateRequest,
  ): Promise<AdminProductView> {
    return this.catalog.create(principal, body);
  }

  /**
   * `PATCH` kullanilir, `PUT` degil: govde yalnizca DEGISEN alanlari tasir.
   *
   * Tam govde gonderen bir uc, istemcinin okumadigi bir alani (baska bir
   * oturumun az once degistirdigi aciklamayi) eski degeriyle geri yazardi.
   */
  @Patch('products/:productId')
  @ApiOperation({ summary: 'Ürün kartını güncelle' })
  update(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body(zodBody(productUpdateSchema)) body: ProductUpdateRequest,
  ): Promise<AdminProductView> {
    return this.catalog.update(principal, productId, body);
  }
}
