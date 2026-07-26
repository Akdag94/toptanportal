/**
 * ToptanPortal - Siparis Uc Noktalari
 *
 * Siparis olusturma iki farkli yetkiyle mumkundur:
 *   ORDER_PLACE              -> siparis dogrudan Logo'ya gider
 *   ORDER_SUBMIT_FOR_APPROVAL -> siparis ana yetkilinin onayina duser
 * Hangisinin gecerli oldugunu SUNUCU belirler; istemcinin secme hakki yoktur.
 *
 * `Idempotency-Key` basligi zayif baglantida cift siparisi engeller: ayni
 * anahtarla gelen ikinci istek yeni siparis acmaz, ilkinin yanitini dondurur.
 */

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  orderListQuerySchema,
  placeOrderSchema,
  rejectOrderSchema,
  type OrderListQuery,
  type OrderView,
  type PlaceOrderRequest,
  type PlaceOrderResult,
  type RejectOrderRequest,
} from '@toptanportal/contracts';

import {
  CurrentUser,
  RateLimit,
  RequireAnyPermission,
  RequirePermissions,
} from '../common/decorators';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import type { AuthenticatedPrincipal } from '../common/context/request-context';
import { OrderService } from './order.service';

@ApiTags('Sipariş')
@Controller('orders')
export class OrderController {
  constructor(
    private readonly orders: OrderService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireAnyPermission(Permission.ORDER_PLACE, Permission.ORDER_SUBMIT_FOR_APPROVAL)
  @RateLimit({ limit: 30, windowSeconds: 300, scope: 'USER' })
  @ApiOperation({ summary: 'Sepetten sipariş oluştur' })
  async place(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(placeOrderSchema)) body: PlaceOrderRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<PlaceOrderResult> {
    return this.idempotency.execute<PlaceOrderResult>(
      {
        tenantId: principal.tenantId,
        userId: principal.userId,
        endpoint: 'POST /orders',
        key: idempotencyKey?.trim() || null,
        request: body,
      },
      () => this.orders.place(principal, body),
    );
  }

  @Get()
  @RequireAnyPermission(
    Permission.ORDER_VIEW_OWN,
    Permission.ORDER_VIEW_COMPANY,
    Permission.ORDER_VIEW_ALL,
  )
  @ApiOperation({ summary: 'Siparişleri listele' })
  async list(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query(zodBody(orderListQuerySchema)) query: OrderListQuery,
  ): Promise<{ items: OrderView[]; nextCursor: string | null }> {
    return this.orders.list(principal, query);
  }

  @Get(':orderId')
  @RequireAnyPermission(
    Permission.ORDER_VIEW_OWN,
    Permission.ORDER_VIEW_COMPANY,
    Permission.ORDER_VIEW_ALL,
  )
  @ApiOperation({ summary: 'Sipariş ayrıntısı' })
  async detail(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string,
  ): Promise<OrderView> {
    return this.orders.getById(principal, orderId);
  }

  @Post(':orderId/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ORDER_APPROVE)
  @ApiOperation({ summary: 'Onay bekleyen siparişi onayla' })
  async approve(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string,
  ): Promise<OrderView> {
    return this.orders.approve(principal, orderId);
  }

  @Post(':orderId/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ORDER_APPROVE)
  @ApiOperation({ summary: 'Onay bekleyen siparişi reddet' })
  async reject(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string,
    @Body(zodBody(rejectOrderSchema)) body: RejectOrderRequest,
  ): Promise<OrderView> {
    return this.orders.reject(principal, orderId, body.reason);
  }

  @Post(':orderId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ORDER_CANCEL)
  @ApiOperation({ summary: 'Siparişi iptal et' })
  async cancel(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string,
  ): Promise<OrderView> {
    return this.orders.cancel(principal, orderId);
  }
}
