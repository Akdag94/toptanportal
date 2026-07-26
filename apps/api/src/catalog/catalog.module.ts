import { Module } from '@nestjs/common';

import { PricingModule } from '../pricing/pricing.module';
import { StockModule } from '../stock/stock.module';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';

@Module({
  imports: [PricingModule, StockModule],
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
