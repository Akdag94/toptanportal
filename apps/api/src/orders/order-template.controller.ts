/**
 * ToptanPortal - Rutin Siparis Sablonu Uc Noktalari
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  createTemplateFromCartSchema,
  upsertOrderTemplateSchema,
  type ApplyTemplateResult,
  type CreateTemplateFromCartRequest,
  type OrderTemplateView,
  type UpsertOrderTemplateRequest,
} from '@toptanportal/contracts';

import { CurrentUser, RequirePermissions } from '../common/decorators';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import { toOwner } from '../cart/cart.controller';
import type { AuthenticatedPrincipal } from '../common/context/request-context';
import { OrderTemplateService } from './order-template.service';

@ApiTags('Sipariş Şablonları')
@Controller('order-templates')
@RequirePermissions(Permission.ORDER_TEMPLATE_MANAGE)
export class OrderTemplateController {
  constructor(private readonly templates: OrderTemplateService) {}

  @Get()
  @ApiOperation({ summary: 'Şablonları listele' })
  async list(@CurrentUser() principal: AuthenticatedPrincipal): Promise<OrderTemplateView[]> {
    return this.templates.list(toOwner(principal));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Şablon oluştur' })
  async create(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(upsertOrderTemplateSchema)) body: UpsertOrderTemplateRequest,
  ): Promise<OrderTemplateView> {
    return this.templates.create(toOwner(principal), body);
  }

  @Post('from-cart')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Mevcut sepetten şablon oluştur' })
  async createFromCart(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(createTemplateFromCartSchema)) body: CreateTemplateFromCartRequest,
  ): Promise<OrderTemplateView> {
    return this.templates.createFromCart(toOwner(principal), body.name, body.isShared);
  }

  @Put(':templateId')
  @ApiOperation({ summary: 'Şablonu güncelle' })
  async update(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('templateId', new ParseUUIDPipe({ version: '4' })) templateId: string,
    @Body(zodBody(upsertOrderTemplateSchema)) body: UpsertOrderTemplateRequest,
  ): Promise<OrderTemplateView> {
    return this.templates.update(toOwner(principal), templateId, body);
  }

  @Post(':templateId/apply')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Şablonu sepete uygula' })
  async apply(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('templateId', new ParseUUIDPipe({ version: '4' })) templateId: string,
  ): Promise<ApplyTemplateResult> {
    return this.templates.applyToCart(toOwner(principal), templateId);
  }

  @Delete(':templateId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Şablonu sil' })
  async remove(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('templateId', new ParseUUIDPipe({ version: '4' })) templateId: string,
  ): Promise<void> {
    await this.templates.remove(toOwner(principal), templateId);
  }
}
