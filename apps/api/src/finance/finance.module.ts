import { Module } from '@nestjs/common';

import { NotificationModule } from '../notification/notification.module';
import { AccountService } from './account.service';
import { FinanceController } from './finance.controller';
import { PaymentService } from './payment.service';

@Module({
  imports: [NotificationModule],
  controllers: [FinanceController],
  providers: [AccountService, PaymentService],
  exports: [AccountService, PaymentService],
})
export class FinanceModule {}
