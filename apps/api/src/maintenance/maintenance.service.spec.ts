/**
 * Bakim gorevlerinin testleri.
 *
 * Kritik davranis: bir gorevin hatasi digerlerini DURDURMAZ. Idempotency
 * temizligi patladi diye stok iadesinin yapilmamasi, gecici bir arizayi
 * kalici bir stok kaybina cevirir.
 */

import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';

import type { IdempotencyService } from '../common/idempotency/idempotency.service';
import type { PrismaService } from '../common/prisma/prisma.service';
import type { IntegrationService } from '../integration/integration.service';
import type { DueReminderService } from '../notification/due-reminder.service';
import type { NotificationDispatchService } from '../notification/notification-dispatch.service';
import type { StockService } from '../stock/stock.service';
import type { LeaderLockService } from './leader-lock.service';
import { MaintenanceService } from './maintenance.service';

interface Overrides {
  releaseExpired?: jest.Mock;
  purgeExpired?: jest.Mock;
  staleCount?: number;
  deadCount?: number;
  lockAcquired?: boolean;
  enabled?: boolean;
  tenants?: { id: string; code: string }[];
  trigger?: jest.Mock;
  probe?: jest.Mock;
  dispatchNotifications?: jest.Mock;
  dueReminderRun?: jest.Mock;
}

function build(overrides: Overrides = {}) {
  const config = {
    getOrThrow: () => ({
      MAINTENANCE_JOBS_ENABLED: overrides.enabled ?? true,
      JOB_RESERVATION_RELEASE_SECONDS: 120,
      JOB_IDEMPOTENCY_PURGE_SECONDS: 3600,
      JOB_OUTBOX_WATCH_SECONDS: 300,
      OUTBOX_STALE_MINUTES: 15,
      JOB_ORDER_DISPATCH_SECONDS: 30,
      JOB_STOCK_SYNC_SECONDS: 120,
      JOB_PRICE_SYNC_SECONDS: 1800,
      JOB_ACCOUNT_SYNC_SECONDS: 900,
      JOB_BRIDGE_PROBE_SECONDS: 300,
      JOB_NOTIFICATION_DISPATCH_SECONDS: 30,
      JOB_DUE_REMINDER_SECONDS: 3600,
    }),
  } as unknown as ConfigService;

  const lock = {
    runExclusively: jest
      .fn()
      .mockImplementation((_name: string, _ttl: number, task: () => Promise<unknown>) =>
        (overrides.lockAcquired ?? true) ? task() : Promise.resolve(null),
      ),
  } as unknown as LeaderLockService;

  const stock = {
    releaseExpired: overrides.releaseExpired ?? jest.fn().mockResolvedValue(0),
  } as unknown as StockService;

  const idempotency = {
    purgeExpired: overrides.purgeExpired ?? jest.fn().mockResolvedValue(0),
  } as unknown as IdempotencyService;

  const counts = [overrides.staleCount ?? 0, overrides.deadCount ?? 0];
  let call = 0;
  const prisma = {
    outboxEvent: {
      count: jest.fn().mockImplementation(() => Promise.resolve(counts[call++ % 2] ?? 0)),
    },
    /* Entegrasyon turleri kiraci basina yurur; kiraci listesi bos oldugunda
       hicbir kopru cagrisi yapilmaz ve bakim testleri agdan bagimsiz kalir. */
    tenant: { findMany: jest.fn().mockResolvedValue(overrides.tenants ?? []) },
  } as unknown as PrismaService;

  const notifications = {
    dispatchBatch:
      overrides.dispatchNotifications ??
      jest.fn().mockResolvedValue({ sent: 0, failed: 0, suppressed: 0 }),
    purgeExpired: jest.fn().mockResolvedValue(0),
  } as unknown as NotificationDispatchService;

  const dueReminders = {
    run: overrides.dueReminderRun ?? jest.fn().mockResolvedValue(0),
  } as unknown as DueReminderService;

  const integration = {
    trigger: overrides.trigger ?? jest.fn().mockResolvedValue(null),
    probe: overrides.probe ?? jest.fn().mockResolvedValue(null),
  } as unknown as IntegrationService;

  return {
    service: new MaintenanceService(
      config,
      lock,
      stock,
      idempotency,
      prisma,
      integration,
      notifications,
      dueReminders,
    ),
    lock,
    stock,
    idempotency,
    integration,
    notifications,
    dueReminders,
  };
}

describe('MaintenanceService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('süresi dolan rezervasyonları serbest bırakır', async () => {
    const releaseExpired = jest.fn().mockResolvedValue(3);
    const { service } = build({ releaseExpired });

    const results = await service.runAllNow();

    expect(releaseExpired).toHaveBeenCalledTimes(1);
    expect(results['stok-rezervasyon-iadesi']).toContain('3 rezervasyon');
  });

  it('yapılacak iş yoksa gürültü üretmez', async () => {
    const { service } = build();

    const results = await service.runAllNow();

    expect(results['stok-rezervasyon-iadesi']).toBe('yapılacak iş yok');
    expect(results['idempotency-temizligi']).toBe('yapılacak iş yok');
  });

  it('bir görevin hatası diğerlerini durdurmaz', async () => {
    const releaseExpired = jest.fn().mockRejectedValue(new Error('veritabanı hatası'));
    const purgeExpired = jest.fn().mockResolvedValue(7);
    const { service } = build({ releaseExpired, purgeExpired });

    const results = await service.runAllNow();

    expect(results['stok-rezervasyon-iadesi']).toBe('yapılacak iş yok');
    expect(purgeExpired).toHaveBeenCalledTimes(1);
    expect(results['idempotency-temizligi']).toContain('7 istek anahtarı');
  });

  it('kilit alınamazsa görev çalışmaz', async () => {
    const releaseExpired = jest.fn().mockResolvedValue(3);
    const { service } = build({ releaseExpired, lockAcquired: false });

    await service.runAllNow();

    expect(releaseExpired).not.toHaveBeenCalled();
  });

  it('birikmiş outbox olaylarını raporlar', async () => {
    const { service } = build({ staleCount: 12, deadCount: 2 });

    const results = await service.runAllNow();

    expect(results['outbox-gozetimi']).toBe('bekleyen=12 ölü=2');
  });

  it('iletilemeyen sipariş olayı varsa hata seviyesinde kayıt üretir', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error');
    const { service } = build({ deadCount: 1 });

    await service.runAllNow();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('İLETİLMEDİ'));
  });

  it('görevler kapalıyken zamanlayıcı kurmaz ve uyarır', () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn');
    const { service } = build({ enabled: false });

    service.onModuleInit();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('serbest bırakılmayacak'));

    service.onModuleDestroy();
  });

  it('görevi zamanlanan aralıkta çalıştırır, kapanışta durdurur', async () => {
    jest.useFakeTimers();

    const releaseExpired = jest.fn().mockResolvedValue(1);
    const { service } = build({ releaseExpired });

    service.onModuleInit();
    expect(releaseExpired).not.toHaveBeenCalled();

    // Rezervasyon iadesi 120 saniyede bir calisir.
    await jest.advanceTimersByTimeAsync(120_000);
    expect(releaseExpired).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(120_000);
    expect(releaseExpired).toHaveBeenCalledTimes(2);

    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(600_000);

    // Kapanistan sonra zamanlayici tetiklenmemeli.
    expect(releaseExpired).toHaveBeenCalledTimes(2);
  });
});
