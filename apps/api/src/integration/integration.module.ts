import { Module } from '@nestjs/common';

import { FinanceModule } from '../finance/finance.module';
import { AccountSyncService } from './account-sync.service';
import { BridgeClient } from './bridge.client';
import { IntegrationController } from './integration.controller';
import { IntegrationService } from './integration.service';
import { OrderDispatchService } from './order-dispatch.service';
import { PriceSyncService } from './price-sync.service';
import { StockSyncService } from './stock-sync.service';
import { SyncCursorService } from './sync-cursor.service';

@Module({
  imports: [FinanceModule],
  controllers: [IntegrationController],
  providers: [
    BridgeClient,
    SyncCursorService,
    StockSyncService,
    PriceSyncService,
    AccountSyncService,
    OrderDispatchService,
    IntegrationService,
  ],
  /* Bakim gorevleri zamanlanmis turlari bu servisler uzerinden calistirir. */
  exports: [IntegrationService, SyncCursorService, OrderDispatchService],
})
export class IntegrationModule {}
