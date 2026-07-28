/**
 * ToptanPortal - Sepet Uc Noktalari
 *
 * Sepet islemleri ORDER_DRAFT yetkisine baglidir. Muhasebeci rolunde bu yetki
 * yoktur; evrak gorur ama siparis olusturamaz. Kor moddaki alt yetkili sepeti
 * duzenleyebilir - goremedigi tek sey tutarlardir.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  bulkImportSchema,
  canSeeFinancials,
  cartItemInputSchema,
  setCartItemQuantitySchema,
  setCartItemsSchema,
  type BulkImportRequest,
  type BulkImportResult,
  type CartItemInput,
  type CartView,
  type SetCartItemQuantityRequest,
  type SetCartItemsRequest,
} from '@toptanportal/contracts';

import { CurrentUser, RequirePermissions } from '../common/decorators';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import { requireCompanyContext } from '../common/context/company-context';
import type { AuthenticatedPrincipal } from '../common/context/request-context';
import { BulkImportService } from './bulk-import.service';
import { CartService, type CartOwner } from './cart.service';

@ApiTags('Sepet')
@Controller('cart')
@RequirePermissions(Permission.ORDER_DRAFT)
export class CartController {
  constructor(
    private readonly cart: CartService,
    private readonly bulk: BulkImportService,
  ) {}

  /**
   * Excel'den kopyalanan listeyi sepete cevirir.
   *
   * Ayri bir yetki ister: toplu ice aktarim, tek bir yapistirma ile yuzlerce
   * kalemlik siparis olusturabilir ve bu, siparis girisinden farkli bir risk
   * seviyesidir.
   */
  @Post('bulk-import')
  @RequirePermissions(Permission.ORDER_IMPORT_BULK)
  @ApiOperation({ summary: 'Excel listesinden sepet oluştur' })
  async bulkImport(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(bulkImportSchema)) body: BulkImportRequest,
  ): Promise<BulkImportResult> {
    return this.bulk.import(
      toOwner(principal),
      principal.tenantId,
      body.content,
      body.replaceExisting,
    );
  }

  @Get()
  @ApiOperation({ summary: 'Sepeti getir' })
  async get(@CurrentUser() principal: AuthenticatedPrincipal): Promise<CartView> {
    return this.cart.getCart(toOwner(principal));
  }

  @Put()
  @ApiOperation({ summary: 'Sepetin tamamını değiştir (çevrimdışı senkronizasyon)' })
  async replace(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(setCartItemsSchema)) body: SetCartItemsRequest,
  ): Promise<CartView> {
    return this.cart.replaceItems(toOwner(principal), body);
  }

  @Post('items')
  @ApiOperation({ summary: 'Sepete ürün ekle (mevcutsa miktarı artırır)' })
  async addItem(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(cartItemInputSchema)) body: CartItemInput,
  ): Promise<CartView> {
    return this.cart.addItem(toOwner(principal), body);
  }

  @Patch('items/:productId/:unitId')
  @ApiOperation({ summary: 'Satır miktarını ayarla' })
  async setQuantity(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Param('unitId', new ParseUUIDPipe({ version: '4' })) unitId: string,
    @Body(zodBody(setCartItemQuantitySchema)) body: SetCartItemQuantityRequest,
  ): Promise<CartView> {
    return this.cart.setItemQuantity(toOwner(principal), productId, unitId, body.quantity);
  }

  @Delete('items/:productId/:unitId')
  @ApiOperation({ summary: 'Satırı sepetten çıkar' })
  async removeItem(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Param('unitId', new ParseUUIDPipe({ version: '4' })) unitId: string,
  ): Promise<CartView> {
    return this.cart.removeItem(toOwner(principal), productId, unitId);
  }

  @Delete()
  @ApiOperation({ summary: 'Sepeti boşalt' })
  async clear(@CurrentUser() principal: AuthenticatedPrincipal): Promise<CartView> {
    return this.cart.clear(toOwner(principal));
  }
}

export function toOwner(principal: AuthenticatedPrincipal): CartOwner {
  return {
    tenantId: principal.tenantId,
    companyId: requireCompanyContext(principal),
    userId: principal.userId,
    canSeePrices: canSeeFinancials(principal.role),
  };
}
