import { Module } from '@nestjs/common';

import { EInvoiceModule } from '../einvoice/einvoice.module';
import { IntegrationModule } from '../integration/integration.module';
import { NotificationModule } from '../notification/notification.module';
import { StockModule } from '../stock/stock.module';
import { LeaderLockService } from './leader-lock.service';
import { MaintenanceService } from './maintenance.service';

@Module({
  imports: [StockModule, IntegrationModule, NotificationModule, EInvoiceModule],
  providers: [MaintenanceService, LeaderLockService],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
