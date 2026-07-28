import { Module } from '@nestjs/common';

import { AccountService } from './account.service';
import { FinanceController } from './finance.controller';
import { PaymentService } from './payment.service';

@Module({
  controllers: [FinanceController],
  providers: [AccountService, PaymentService],
  exports: [AccountService, PaymentService],
})
export class FinanceModule {}
