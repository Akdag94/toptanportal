/**
 * ToptanPortal API - Entegrasyon Durumu ve Yonetimi
 *
 * Yonetim ekraninin tek veri kaynagi. Burada uretilen tabloda operatorun
 * sormasi gereken tek soru cevaplanir: "Logo ile arasi iyi mi, degilse ne
 * yapmam gerekiyor?"
 *
 * Bu yuzden durum ozeti SAYIYA degil YASA dayanir. "142 olay bekliyor" tek
 * basina alarm degildir - gece calisan bir toplu is de bunu uretir. "En eski
 * olay 40 dakikadir bekliyor" ise her zaman alarmdir.
 */

import { Injectable, Logger } from '@nestjs/common';
import { OutboxStatus, SyncChannel } from '@toptanportal/db';
import { randomUUID } from 'node:crypto';
import {
  SyncChannel as SyncChannelContract,
  type BridgeHealth,
  type DeadEventView,
  type IntegrationStatus,
  type SyncRunResult,
} from '@toptanportal/contracts';

import { PrismaService } from '../common/prisma/prisma.service';
import { AccountSyncService } from './account-sync.service';
import { BridgeClient } from './bridge.client';
import { OrderDispatchService } from './order-dispatch.service';
import { PriceSyncService } from './price-sync.service';
import { StockSyncService } from './stock-sync.service';
import { SyncCursorService } from './sync-cursor.service';

@Injectable()
export class IntegrationService {
  private readonly logger = new Logger(IntegrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bridge: BridgeClient,
    private readonly cursors: SyncCursorService,
    private readonly stockSync: StockSyncService,
    private readonly priceSync: PriceSyncService,
    private readonly accountSync: AccountSyncService,
    private readonly dispatch: OrderDispatchService,
  ) {}

  /**
   * Kopruyu yoklar ve sonucu kaydeder.
   *
   * Yoklama BASARISIZ olsa da kaydedilir: "kopru ulasilamiyor" bilgisi, hic
   * kayit olmamasindan cok daha degerlidir. Kayit yoksa operator, yoklamanin
   * hic yapilmadigini mi yoksa basarisiz oldugunu mu bilemez.
   */
  async probe(tenantId: string): Promise<BridgeHealth | null> {
    if (!this.bridge.isConfigured) return null;

    const baslangic = Date.now();

    try {
      const saglik = await this.bridge.health();

      await this.prisma.bridgeHealthCheck.create({
        data: {
          tenantId,
          status: saglik.status,
          version: saglik.version,
          logoServiceUp: saglik.logoServiceUp,
          databaseUp: saglik.databaseUp,
          companyNumber: saglik.companyNumber,
          periodNumber: saglik.periodNumber,
          message: saglik.message?.slice(0, 500) ?? null,
          latencyMs: Date.now() - baslangic,
        },
      });

      return saglik;
    } catch (error) {
      const mesaj = error instanceof Error ? error.message : 'bilinmeyen hata';

      await this.prisma.bridgeHealthCheck.create({
        data: {
          tenantId,
          status: 'UNREACHABLE',
          logoServiceUp: false,
          databaseUp: false,
          message: mesaj.slice(0, 500),
          latencyMs: Date.now() - baslangic,
        },
      });

      this.logger.warn(`Köprü yoklaması başarısız: ${mesaj}`);
      return null;
    }
  }

  async status(tenantId: string): Promise<IntegrationStatus> {
    await this.cursors.ensure(tenantId);

    const [channels, bekleyen, olu, enEski, sonYoklama] = await Promise.all([
      this.cursors.list(tenantId),
      this.prisma.outboxEvent.count({ where: { tenantId, status: OutboxStatus.PENDING } }),
      this.prisma.outboxEvent.count({ where: { tenantId, status: OutboxStatus.DEAD } }),
      this.prisma.outboxEvent.findFirst({
        where: { tenantId, status: OutboxStatus.PENDING },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      this.prisma.bridgeHealthCheck.findFirst({
        where: { tenantId },
        orderBy: { checkedAt: 'desc' },
      }),
    ]);

    return {
      bridgeConfigured: this.bridge.isConfigured,
      health: sonYoklama
        ? {
            status: sonYoklama.status as BridgeHealth['status'],
            version: sonYoklama.version ?? '—',
            logoServiceUp: sonYoklama.logoServiceUp,
            databaseUp: sonYoklama.databaseUp,
            companyNumber: sonYoklama.companyNumber ?? 0,
            periodNumber: sonYoklama.periodNumber ?? 0,
            checkedAt: sonYoklama.checkedAt.toISOString(),
            message: sonYoklama.message,
          }
        : null,
      channels,
      pendingEvents: bekleyen,
      deadEvents: olu,
      oldestPendingSeconds: enEski
        ? Math.floor((Date.now() - enEski.createdAt.getTime()) / 1000)
        : null,
    };
  }

  async deadEvents(tenantId: string, limit = 50): Promise<DeadEventView[]> {
    const olaylar = await this.prisma.outboxEvent.findMany({
      where: { tenantId, status: OutboxStatus.DEAD },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    /* Siparis numaralari tek sorguda cekilir: olay basina sorgu, 50 satirlik
       bir ekrani 50 gidis-donuse cikarir. */
    const siparisKimlikleri = olaylar
      .filter((olay) => olay.aggregateType === 'Order')
      .map((olay) => olay.aggregateId);

    const siparisler = await this.prisma.order.findMany({
      where: { id: { in: siparisKimlikleri } },
      select: { id: true, orderNumber: true },
    });

    const numaraHaritasi = new Map(siparisler.map((s) => [s.id, s.orderNumber]));

    return olaylar.map((olay) => ({
      id: olay.id.toString(),
      eventType: olay.eventType,
      aggregateId: olay.aggregateId,
      label: numaraHaritasi.get(olay.aggregateId) ?? null,
      attempts: olay.attempts,
      lastError: olay.lastError,
      createdAt: olay.createdAt.toISOString(),
    }));
  }

  retryDeadEvents(tenantId: string, eventIds?: string[]): Promise<number> {
    return this.dispatch.retryDead(tenantId, eventIds);
  }

  /**
   * Kanali elle calistirir. Zamanlanmis turdan tek farki, tetigi operatorun
   * cekmesidir; kilit ve imlec kurallari aynidir - elle tetikleme, es zamanli
   * calisan bir turu ikiye katlamaz.
   */
  async trigger(
    tenantId: string,
    channel: SyncChannelContract,
    fullResync: boolean,
  ): Promise<SyncRunResult | null> {
    await this.cursors.ensure(tenantId);

    if (fullResync) {
      await this.cursors.reset(tenantId, channel as SyncChannel);
    }

    const workerId = `manual-${randomUUID().slice(0, 8)}`;

    switch (channel) {
      case SyncChannelContract.STOCK:
        return this.stockSync.run(tenantId, workerId);
      case SyncChannelContract.PRICE:
        return this.priceSync.run(tenantId, workerId);
      case SyncChannelContract.ACCOUNT:
        return this.accountSync.run(tenantId, workerId);
      case SyncChannelContract.ORDER: {
        const islenen = await this.dispatch.run(tenantId, workerId);
        return {
          channel: SyncChannelContract.ORDER,
          itemCount: islenen,
          durationMs: 0,
          hasMore: false,
          cursor: null,
        };
      }
      default:
        return null;
    }
  }

  setChannelEnabled(
    tenantId: string,
    channel: SyncChannelContract,
    enabled: boolean,
  ): Promise<void> {
    return this.cursors.setEnabled(tenantId, channel as SyncChannel, enabled);
  }
}
