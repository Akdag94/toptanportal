/**
 * ToptanPortal - Bakim Gorevleri
 *
 * NEDEN GEREKLI: Siparis akisi, telafi edilmesi gereken izler birakir.
 *  * Onaya dusen siparis onaylanmaz veya reddedilmezse rezerve stok askida
 *    kalir. Bu stok satilabilir olmadigi halde depoda durur - toptancinin en
 *    pahali sessiz kaybi budur.
 *  * Idempotency anahtarlari suresiz saklanirsa tablo sinirsiz buyur.
 *  * Outbox'ta bekleyen olaylar birikirse, Logo koprusunun calismadigi
 *    kimsenin fark etmedigi bir sekilde uzun sure gizli kalir.
 *
 * Gorevler kilit altinda calisir (bkz. LeaderLockService); coklu ornekte
 * yalnizca biri isi yapar. Bir gorevin hatasi digerlerini durdurmaz ve
 * uygulamayi cokertmez.
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxStatus } from '@toptanportal/db';
import { SyncChannel as SyncChannelContract } from '@toptanportal/contracts';

import type { AppConfig } from '../config/configuration';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { IntegrationService } from '../integration/integration.service';
import { StockService } from '../stock/stock.service';
import { LeaderLockService } from './leader-lock.service';

interface JobDefinition {
  name: string;
  intervalSeconds: number;
  lockTtlSeconds: number;
  run: () => Promise<string | null>;
}

@Injectable()
export class MaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaintenanceService.name);
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly lock: LeaderLockService,
    private readonly stock: StockService,
    private readonly idempotency: IdempotencyService,
    private readonly prisma: PrismaService,
    private readonly integration: IntegrationService,
  ) {
    const app = this.config.getOrThrow<AppConfig>('app');
    this.enabled = app.MAINTENANCE_JOBS_ENABLED;
  }

  private get jobs(): JobDefinition[] {
    const app = this.config.getOrThrow<AppConfig>('app');

    return [
      {
        name: 'stok-rezervasyon-iadesi',
        intervalSeconds: app.JOB_RESERVATION_RELEASE_SECONDS,
        // Iade her siparis icin ayri islem acar; genis pay birakilir.
        lockTtlSeconds: 300,
        run: async () => {
          const released = await this.stock.releaseExpired();
          return released > 0 ? `${released} rezervasyon serbest bırakıldı` : null;
        },
      },
      {
        name: 'idempotency-temizligi',
        intervalSeconds: app.JOB_IDEMPOTENCY_PURGE_SECONDS,
        lockTtlSeconds: 120,
        run: async () => {
          const purged = await this.idempotency.purgeExpired();
          return purged > 0 ? `${purged} istek anahtarı silindi` : null;
        },
      },
      {
        name: 'outbox-gozetimi',
        intervalSeconds: app.JOB_OUTBOX_WATCH_SECONDS,
        lockTtlSeconds: 60,
        run: () => this.watchOutbox(app.OUTBOX_STALE_MINUTES),
      },
      {
        name: 'siparis-aktarimi',
        intervalSeconds: app.JOB_ORDER_DISPATCH_SECONDS,
        /* Her olay bir ag cagrisidir ve siparis yazimi Logo'da yavastir;
           kilit suresi tur suresinden belirgin sekilde uzun tutulur. */
        lockTtlSeconds: 600,
        run: () => this.dispatchOrders(),
      },
      {
        name: 'stok-senkronu',
        intervalSeconds: app.JOB_STOCK_SYNC_SECONDS,
        lockTtlSeconds: 600,
        run: () => this.syncChannel(SyncChannelContract.STOCK),
      },
      {
        name: 'fiyat-senkronu',
        intervalSeconds: app.JOB_PRICE_SYNC_SECONDS,
        lockTtlSeconds: 1800,
        run: () => this.syncChannel(SyncChannelContract.PRICE),
      },
      {
        name: 'cari-senkronu',
        intervalSeconds: app.JOB_ACCOUNT_SYNC_SECONDS,
        lockTtlSeconds: 900,
        run: () => this.syncChannel(SyncChannelContract.ACCOUNT),
      },
      {
        name: 'kopru-yoklamasi',
        intervalSeconds: app.JOB_BRIDGE_PROBE_SECONDS,
        lockTtlSeconds: 60,
        run: () => this.probeBridge(),
      },
    ];
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn(
        'Bakım görevleri devre dışı (MAINTENANCE_JOBS_ENABLED=false). ' +
          'Süresi dolan stok rezervasyonları serbest bırakılmayacak.',
      );
      return;
    }

    for (const job of this.jobs) {
      const timer = setInterval(() => {
        void this.execute(job);
      }, job.intervalSeconds * 1000);

      // Zamanlayici surecin kapanmasini engellemez.
      timer.unref();
      this.timers.push(timer);
    }

    this.logger.log(`${this.timers.length} bakım görevi zamanlandı.`);
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers.length = 0;
  }

  /** Gorevleri elle tetiklemek icin (yonetim uc noktasi ve testler). */
  async runAllNow(): Promise<Record<string, string>> {
    const results: Record<string, string> = {};

    for (const job of this.jobs) {
      results[job.name] = (await this.execute(job)) ?? 'yapılacak iş yok';
    }

    return results;
  }

  private async execute(job: JobDefinition): Promise<string | null> {
    try {
      const outcome = await this.lock.runExclusively(job.name, job.lockTtlSeconds, job.run);

      if (outcome === null) {
        // Kilit baska bir ornekte ya da yapilacak is yok - ikisi de sessizdir.
        return null;
      }

      this.logger.log(`${job.name}: ${outcome}`);
      return outcome;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `${job.name} görevi başarısız: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
      return null;
    }
  }

  /**
   * Outbox saglik gozetimi.
   *
   * Olaylarin birikmesi TASARIM GEREGIDIR: Logo bakimda olsa bile portal
   * siparis almaya devam eder. Sorun, bu durumun FARK EDILMEMESIDIR. En eski
   * bekleyen olay esigi asarsa uyari uretilir; DEAD olaylar ise her zaman
   * manuel mudahale gerektirir.
   */
  private async watchOutbox(staleMinutes: number): Promise<string | null> {
    const staleBefore = new Date(Date.now() - staleMinutes * 60 * 1000);

    const [stale, dead] = await Promise.all([
      this.prisma.outboxEvent.count({
        where: { status: OutboxStatus.PENDING, createdAt: { lt: staleBefore } },
      }),
      this.prisma.outboxEvent.count({ where: { status: OutboxStatus.DEAD } }),
    ]);

    if (dead > 0) {
      this.logger.error(
        `${dead} outbox olayı azami deneme sayısını aştı (DEAD). Bu siparişler ` +
          'muhasebe sistemine İLETİLMEDİ ve manuel müdahale bekliyor.',
      );
    }

    if (stale > 0) {
      this.logger.warn(
        `${stale} outbox olayı ${staleMinutes} dakikadan uzun süredir bekliyor. ` +
          'Logo köprüsünün çalıştığını doğrulayın.',
      );
    }

    if (stale === 0 && dead === 0) return null;

    return `bekleyen=${stale} ölü=${dead}`;
  }

  // -------------------------------------------------------------------------
  // Logo entegrasyonu turleri
  //
  // Turler KIRACI BASINA yurutulur. Tek bir kiracinin koprusu kapali oldugunda
  // digerlerinin senkronu durmamalidir; bu yuzden her kiracinin hatasi kendi
  // icinde yutulur ve tur devam eder.
  // -------------------------------------------------------------------------

  private async aktifKiracilar(): Promise<{ id: string; code: string }[]> {
    return this.prisma.tenant.findMany({
      where: { isActive: true },
      select: { id: true, code: true },
    });
  }

  private async syncChannel(channel: SyncChannelContract): Promise<string | null> {
    const ozet: string[] = [];

    for (const kiraci of await this.aktifKiracilar()) {
      try {
        const sonuc = await this.integration.trigger(kiraci.id, channel, false);
        if (sonuc && sonuc.itemCount > 0) {
          ozet.push(`${kiraci.code}: ${sonuc.itemCount} kayıt`);
        }
      } catch (error) {
        this.logger.error(
          `${kiraci.code} kiracısında ${channel} senkronu başarısız: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }

    return ozet.length > 0 ? ozet.join(' · ') : null;
  }

  private async dispatchOrders(): Promise<string | null> {
    let toplam = 0;

    for (const kiraci of await this.aktifKiracilar()) {
      try {
        const sonuc = await this.integration.trigger(kiraci.id, SyncChannelContract.ORDER, false);
        toplam += sonuc?.itemCount ?? 0;
      } catch (error) {
        this.logger.error(
          `${kiraci.code} kiracısında sipariş aktarımı başarısız: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }

    return toplam > 0 ? `${toplam} sipariş olayı işlendi` : null;
  }

  /**
   * Kopru yoklamasi. Sonuc BASARISIZ olsa bile kaydedilir; yoklamanin kendisi
   * gorev ciktisi uretmez - operator durumu yonetim ekranindan okur, gunlukte
   * her bes dakikada bir "kopru saglikli" satiri gormek gurultudur.
   */
  private async probeBridge(): Promise<string | null> {
    let ulasilamayan = 0;

    for (const kiraci of await this.aktifKiracilar()) {
      const saglik = await this.integration.probe(kiraci.id);
      if (saglik === null) ulasilamayan += 1;
    }

    return ulasilamayan > 0 ? `${ulasilamayan} kiracıda köprüye ulaşılamadı` : null;
  }
}
