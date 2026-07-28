/**
 * ToptanPortal - Kok Modul
 *
 * MUHAFIZ SIRASI (kritik):
 *   1. JwtAuthGuard      - kimligi cozer ve baglami doldurur
 *   2. RateLimitGuard    - kullanici bazli sayaclar icin kimlige ihtiyac duyar
 *   3. PermissionsGuard  - rol/yetki matrisini uygular
 *   4. IpWhitelistGuard  - yonetim rolleri icin ag kisiti
 *
 * Ardindan BlindOrderInterceptor yaniti suzer. Bu sira degistirilmemelidir;
 * ozellikle Kor Siparis suzgeci en sonda calismali ki hicbir yanit onu atlayamasin.
 */

import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { configurationFactory } from './config/configuration';
import { AuditModule } from './common/audit/audit.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { CompanyScopeModule } from './common/context/company-scope.module';
import { RequestContextMiddleware } from './common/context/request-context.middleware';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { BlindOrderInterceptor } from './common/interceptors/blind-order.interceptor';
import { IpWhitelistGuard } from './common/guards/ip-whitelist.guard';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { RateLimitGuard } from './common/guards/rate-limit.guard';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { OutboxModule } from './common/outbox/outbox.module';
import { AuthModule } from './auth/auth.module';
import { CartModule } from './cart/cart.module';
import { CatalogModule } from './catalog/catalog.module';
import { FinanceModule } from './finance/finance.module';
import { HealthModule } from './health/health.module';
import { AuditQueryModule } from './audit/audit-query.module';
import { EInvoiceModule } from './einvoice/einvoice.module';
import { FieldModule } from './field/field.module';
import { IntegrationModule } from './integration/integration.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { PosModule } from './pos/pos.module';
import { OrdersModule } from './orders/orders.module';
import { PricingModule } from './pricing/pricing.module';
import { StockModule } from './stock/stock.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configurationFactory],
    }),
    PrismaModule,
    RedisModule,
    CryptoModule,
    AuditModule,
    OutboxModule,
    IdempotencyModule,
    CompanyScopeModule,
    AuthModule,
    HealthModule,
    PricingModule,
    StockModule,
    CatalogModule,
    CartModule,
    OrdersModule,
    FinanceModule,
    IntegrationModule,
    PosModule,
    EInvoiceModule,
    FieldModule,
    AuditQueryModule,
    MaintenanceModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: IpWhitelistGuard },
    { provide: APP_INTERCEPTOR, useClass: BlindOrderInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
