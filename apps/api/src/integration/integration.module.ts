import { Module } from '@nestjs/common';

import { OutboxModule } from '../common/outbox/outbox.module';
import { FinanceModule } from '../finance/finance.module';
import { AccountSyncService } from './account-sync.service';
import { BridgeClient } from './bridge.client';
import { CatalogDispatchService } from './catalog-dispatch.service';
import { IntegrationController } from './integration.controller';
import { IntegrationService } from './integration.service';
import { OrderDispatchService } from './order-dispatch.service';
import { PriceSyncService } from './price-sync.service';
import { StockSyncService } from './stock-sync.service';
import { SyncCursorService } from './sync-cursor.service';

@Module({
  imports: [FinanceModule, OutboxModule],
  controllers: [IntegrationController],
  providers: [
    BridgeClient,
    SyncCursorService,
    StockSyncService,
    PriceSyncService,
    AccountSyncService,
    OrderDispatchService,
    CatalogDispatchService,
    IntegrationService,
  ],
  /* Bakim gorevleri zamanlanmis turlari bu servisler uzerinden calistirir. */
  exports: [IntegrationService, SyncCursorService, OrderDispatchService, CatalogDispatchService],
})
export class IntegrationModule {}
