import { Module } from '@nestjs/common';

import { PricingContextService } from './pricing-context.service';
import { PricingService } from './pricing.service';

@Module({
  providers: [PricingService, PricingContextService],
  exports: [PricingService, PricingContextService],
})
export class PricingModule {}
