/**
 * ToptanPortal - Cari Hesap ve Tahsilat Uc Noktalari
 *
 * Kor Siparis Modundaki kullanici bu uc noktalarin HICBIRINE ulasamaz: rol
 * matrisinde BALANCE_VIEW / STATEMENT_VIEW / AGING_REPORT_VIEW yetkileri yoktur,
 * istek muhafiz katmaninda reddedilir. Yanit suzgeci burada ikinci savunmadir.
 *
 * `companyId` sorgu parametresi yalnizca baskasinin carisini gorebilen roller
 * icin anlamlidir (admin, plasiyer); dogrulamasi CompanyScopeService'te yapilir.
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
  agingQuerySchema,
  cancelPaymentSchema,
  paymentListQuerySchema,
  recordPaymentSchema,
  statementQuerySchema,
  type AccountSummary,
  type AgingQuery,
  type AgingReport,
  type CancelPaymentRequest,
  type PaymentListQuery,
  type PaymentPage,
  type PaymentView,
  type RecordPaymentRequest,
  type StatementPage,
  type StatementQuery,
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
import { AccountService } from './account.service';
import { PaymentService } from './payment.service';

@ApiTags('Cari Hesap')
@Controller('finance')
export class FinanceController {
  constructor(
    private readonly account: AccountService,
    private readonly payments: PaymentService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('summary')
  @RequirePermissions(Permission.BALANCE_VIEW)
  @ApiOperation({ summary: 'Cari bakiye ve risk özeti' })
  async summary(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query(zodBody(agingQuerySchema)) query: AgingQuery,
  ): Promise<AccountSummary> {
    return this.account.getSummary(principal, query.companyId);
  }

  @Get('statement')
  @RequirePermissions(Permission.STATEMENT_VIEW)
  @ApiOperation({ summary: 'Cari hesap ekstresi' })
  async statement(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query(zodBody(statementQuerySchema)) query: StatementQuery,
  ): Promise<StatementPage> {
    return this.account.getStatement(principal, query);
  }

  @Get('aging')
  @RequirePermissions(Permission.AGING_REPORT_VIEW)
  @ApiOperation({ summary: 'Yaşlandırma raporu' })
  async aging(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query(zodBody(agingQuerySchema)) query: AgingQuery,
  ): Promise<AgingReport> {
    return this.account.getAging(principal, query.companyId);
  }

  @Post('payments')
  @HttpCode(HttpStatus.CREATED)
  @RequireAnyPermission(Permission.PAYMENT_CREATE, Permission.COLLECTION_RECORD)
  @RateLimit({ limit: 30, windowSeconds: 300, scope: 'USER' })
  @ApiOperation({ summary: 'Tahsilat kaydet' })
  async recordPayment(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(recordPaymentSchema)) body: RecordPaymentRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<PaymentView> {
    return this.idempotency.execute<PaymentView>(
      {
        tenantId: principal.tenantId,
        userId: principal.userId,
        endpoint: 'POST /finance/payments',
        key: idempotencyKey?.trim() || null,
        request: body,
      },
      () => this.payments.record(principal, body),
    );
  }

  @Get('payments')
  @RequireAnyPermission(
    Permission.PAYMENT_CREATE,
    Permission.COLLECTION_RECORD,
    Permission.BALANCE_VIEW,
  )
  @ApiOperation({ summary: 'Tahsilatları listele' })
  async listPayments(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query(zodBody(paymentListQuerySchema)) query: PaymentListQuery,
  ): Promise<PaymentPage> {
    return this.payments.list(principal, query);
  }

  /**
   * Fiziksel teslim gerektiren tahsilatin (nakit, cek, senet) toptanci
   * tarafinda dogrulanmasi. Isletme rollerinde COMPANY_MANAGE bulunmaz.
   */
  @Post('payments/:paymentId/confirm')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.COMPANY_MANAGE)
  @ApiOperation({ summary: 'Tahsilatı onayla' })
  async confirmPayment(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('paymentId', new ParseUUIDPipe({ version: '4' })) paymentId: string,
  ): Promise<PaymentView> {
    return this.payments.confirm(principal, paymentId);
  }

  @Post('payments/:paymentId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.COMPANY_MANAGE)
  @ApiOperation({ summary: 'Tahsilat kaydını iptal et' })
  async cancelPayment(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('paymentId', new ParseUUIDPipe({ version: '4' })) paymentId: string,
    @Body(zodBody(cancelPaymentSchema)) body: CancelPaymentRequest,
  ): Promise<PaymentView> {
    return this.payments.cancel(principal, paymentId, body.reason);
  }
}
