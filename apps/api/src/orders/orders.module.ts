import { Module } from '@nestjs/common';

import { CartModule } from '../cart/cart.module';
import { NotificationModule } from '../notification/notification.module';
import { StockModule } from '../stock/stock.module';
import { OrderController } from './order.controller';
import { OrderNumberService } from './order-number.service';
import { OrderService } from './order.service';
import { OrderTemplateController } from './order-template.controller';
import { OrderTemplateService } from './order-template.service';
import { SpendingLimitService } from './spending-limit.service';

@Module({
  imports: [CartModule, StockModule, NotificationModule],
  controllers: [OrderController, OrderTemplateController],
  providers: [OrderService, OrderNumberService, SpendingLimitService, OrderTemplateService],
  exports: [OrderService],
})
export class OrdersModule {}
