import { Module } from '@nestjs/common';

import { OutboxModule } from '../common/outbox/outbox.module';
import { PriceChangeService } from './price-change.service';
import { PriceListController } from './price-list.controller';
import { PricingContextService } from './pricing-context.service';
import { PricingService } from './pricing.service';

@Module({
  imports: [OutboxModule],
  controllers: [PriceListController],
  providers: [PricingService, PricingContextService, PriceChangeService],
  exports: [PricingService, PricingContextService],
})
export class PricingModule {}
