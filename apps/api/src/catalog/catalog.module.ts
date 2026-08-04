import { Module } from '@nestjs/common';

import { OutboxModule } from '../common/outbox/outbox.module';
import { PricingModule } from '../pricing/pricing.module';
import { StockModule } from '../stock/stock.module';
import { CatalogAdminController } from './catalog-admin.controller';
import { CatalogAdminService } from './catalog-admin.service';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';

@Module({
  imports: [PricingModule, StockModule, OutboxModule],
  controllers: [CatalogController, CatalogAdminController],
  providers: [CatalogService, CatalogAdminService],
  exports: [CatalogService],
})
export class CatalogModule {}
