import { Module } from '@nestjs/common';

import { IntegrationModule } from '../integration/integration.module';
import { StockModule } from '../stock/stock.module';
import { LeaderLockService } from './leader-lock.service';
import { MaintenanceService } from './maintenance.service';

@Module({
  imports: [StockModule, IntegrationModule],
  providers: [MaintenanceService, LeaderLockService],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
