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

import type { AppConfig } from '../config/configuration';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { PrismaService } from '../common/prisma/prisma.service';
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
}
