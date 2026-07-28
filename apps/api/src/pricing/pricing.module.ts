import { Module } from '@nestjs/common';

import { PriceListController } from './price-list.controller';
import { PricingContextService } from './pricing-context.service';
import { PricingService } from './pricing.service';

@Module({
  controllers: [PriceListController],
  providers: [PricingService, PricingContextService],
  exports: [PricingService, PricingContextService],
})
export class PricingModule {}
