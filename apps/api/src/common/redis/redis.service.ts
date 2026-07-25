/**
 * ToptanPortal - Redis Servisi
 *
 * Sorumluluklar:
 *  * Hiz sinirlama sayaclari (anti-scraping / brute-force)
 *  * Oturum ve MFA challenge tekil kullanim kilitleri
 *  * Ileride: stok ve fiyat onbellegi (< 150 ms yanit hedefi)
 *
 * Redis erisilemez oldugunda uygulama COKMEZ; guvenlikle ilgili sayaclar
 * "acik devre" degil "kapali devre" calisir - yani supheli durumda istek
 * reddedilir. Erisilebilirlik ugruna guvenlikten odun verilmez.
 */

import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { type RedisOptions } from 'ioredis';

import type { AppConfig } from '../../config/configuration';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Pencerenin sifirlanmasina kalan saniye. */
  resetAfterSeconds: number;
}

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private isReady = false;

  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  static createClient(configService: ConfigService): Redis {
    const config = configService.getOrThrow<AppConfig>('app');

    const options: RedisOptions = {
      host: config.REDIS_HOST,
      port: config.REDIS_PORT,
      db: config.REDIS_DB,
      lazyConnect: true,
      enableReadyCheck: true,
      maxRetriesPerRequest: 2,
      connectTimeout: 3000,
      commandTimeout: 2000,
      retryStrategy: (attempt: number) => Math.min(attempt * 200, 5000),
    };

    if (config.REDIS_PASSWORD) {
      options.password = config.REDIS_PASSWORD;
    }

    if (config.REDIS_TLS) {
      options.tls = { servername: config.REDIS_HOST };
    }

    return new Redis(options);
  }

  async onModuleInit(): Promise<void> {
    this.client.on('error', (error: Error) => {
      this.isReady = false;
      this.logger.error(`Redis hatası: ${error.message}`);
    });

    this.client.on('ready', () => {
      this.isReady = true;
      this.logger.log('Redis bağlantısı hazır.');
    });

    try {
      await this.client.connect();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Redis bağlantısı kurulamadı: ${message}`);
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }

  get raw(): Redis {
    return this.client;
  }

  get healthy(): boolean {
    return this.isReady;
  }

  async ping(): Promise<boolean> {
    try {
      const reply = await this.client.ping();
      return reply === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * Sabit pencereli sayac. INCR + EXPIRE atomik olarak calistirilir.
   * @param key Sayac anahtari
   * @param limit Pencere basina izin verilen istek sayisi
   * @param windowSeconds Pencere uzunlugu
   */
  async consumeRateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    const script = `
      local current = redis.call('INCR', KEYS[1])
      if current == 1 then
        redis.call('EXPIRE', KEYS[1], ARGV[1])
      end
      local ttl = redis.call('TTL', KEYS[1])
      return { current, ttl }
    `;

    try {
      const reply = (await this.client.eval(script, 1, key, windowSeconds)) as [
        number,
        number,
      ];
      const [current, ttl] = reply;
      const resetAfterSeconds = ttl > 0 ? ttl : windowSeconds;

      return {
        allowed: current <= limit,
        remaining: Math.max(0, limit - current),
        resetAfterSeconds,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Hız sınırlama sayacı okunamadı (${key}): ${message}`);
      // Kapali devre: sayac calismiyorsa istek reddedilir.
      return { allowed: false, remaining: 0, resetAfterSeconds: windowSeconds };
    }
  }

  /**
   * Tek kullanimlik jeton tuketimi. Ayni MFA challenge'in iki kez kullanilmasini
   * engeller (replay koruması).
   * @returns true ise jeton bu cagrida tuketildi; false ise zaten kullanilmis.
   */
  async consumeOnce(key: string, ttlSeconds: number): Promise<boolean> {
    try {
      const reply = await this.client.set(key, '1', 'EX', ttlSeconds, 'NX');
      return reply === 'OK';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Tek kullanımlık jeton işaretlenemedi (${key}): ${message}`);
      return false;
    }
  }

  /** Anahtarin var olup olmadigini soyler; hata durumunda guvenli tarafta kalir. */
  async exists(key: string): Promise<boolean> {
    try {
      return (await this.client.exists(key)) === 1;
    } catch {
      return false;
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Redis yazma başarısız (${key}): ${message}`);
    }
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Redis okuma başarısız (${key}): ${message}`);
      return null;
    }
  }

  async delete(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.client.del(...keys);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Redis silme başarısız: ${message}`);
    }
  }
}
