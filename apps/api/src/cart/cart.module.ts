import { Module } from '@nestjs/common';

import { PricingModule } from '../pricing/pricing.module';
import { StockModule } from '../stock/stock.module';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';

@Module({
  imports: [PricingModule, StockModule],
  controllers: [CartController],
  providers: [CartService],
  exports: [CartService],
})
export class CartModule {}
