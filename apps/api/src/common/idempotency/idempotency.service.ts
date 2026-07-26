/**
 * ToptanPortal - Idempotency-Key Destegi
 *
 * Depoda zayif GSM sinyali altinda "Siparisi Onayla" dokunusu sik sik iki kez
 * gider: istemci yaniti alamaz, kullanici tekrar basar. Ayni anahtarla gelen
 * ikinci istek YENI siparis olusturmamali, ilkinin yanitini dondurmelidir.
 *
 * Uc durum vardir:
 *   1. Anahtar yok            -> islem calisir, sonuc saklanir
 *   2. Anahtar var, tamamlandi -> saklanan yanit aynen dondurulur
 *   3. Anahtar var, devam ediyor -> 409; istemci kisa sure sonra tekrar dener
 *
 * Istek govdesinin ozeti de saklanir: ayni anahtarla FARKLI govde gelirse bu
 * bir istemci hatasidir ve sessizce eski yaniti dondurmek yanlis olur.
 */

import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ErrorCode, canonicalJson } from '@toptanportal/contracts';
import { Prisma } from '@toptanportal/db';

import { ApiException } from '../exceptions/api.exception';
import { PrismaService } from '../prisma/prisma.service';

/** Anahtarlar 24 saat sonra dusulur; mobil istemcinin tekrar denemesi icin fazlasiyla yeterli. */
const RETENTION_HOURS = 24;

export interface IdempotentExecution {
  tenantId: string;
  userId: string;
  endpoint: string;
  key: string | null;
  request: unknown;
}

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Islemi en fazla bir kez calistirir.
   * Anahtar verilmemisse koruma yoktur - istemci sorumluluk alir.
   */
  async execute<T>(execution: IdempotentExecution, operation: () => Promise<T>): Promise<T> {
    if (!execution.key) {
      return operation();
    }

    const storageKey = `${execution.tenantId}:${execution.key}`;
    const requestHash = createHash('sha256').update(canonicalJson(execution.request)).digest('hex');

    const existing = await this.claim<T>(execution, storageKey, requestHash);

    if (existing) {
      return existing;
    }

    try {
      const result = await operation();

      await this.prisma.idempotencyKey.update({
        where: { key: storageKey },
        data: {
          responseCode: 201,
          responseBody: JSON.parse(canonicalJson(result)) as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });

      return result;
    } catch (error) {
      // Basarisiz islem anahtari tuketmemelidir; musteri duzeltip ayni
      // anahtarla tekrar deneyebilmelidir.
      await this.prisma.idempotencyKey
        .delete({ where: { key: storageKey } })
        .catch((cleanupError: unknown) => {
          const message =
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          this.logger.warn(`Idempotency anahtarı temizlenemedi (${storageKey}): ${message}`);
        });

      throw error;
    }
  }

  /**
   * Anahtari sahiplenmeye calisir.
   * null donerse islem calistirilabilir; deger donerse onceki yanit gecerlidir.
   */
  private async claim<T>(
    execution: IdempotentExecution,
    storageKey: string,
    requestHash: string,
  ): Promise<T | null> {
    try {
      await this.prisma.idempotencyKey.create({
        data: {
          key: storageKey,
          tenantId: execution.tenantId,
          userId: execution.userId,
          endpoint: execution.endpoint,
          requestHash,
          expiresAt: new Date(Date.now() + RETENTION_HOURS * 60 * 60 * 1000),
        },
      });

      return null;
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== 'P2002'
      ) {
        throw error;
      }
    }

    const previous = await this.prisma.idempotencyKey.findUnique({
      where: { key: storageKey },
      select: { requestHash: true, responseBody: true, completedAt: true },
    });

    if (!previous) {
      // Yarisi kaybettik ama kayit da silinmis (basarisiz islem temizligi).
      // Islemin calismasina izin ver.
      return null;
    }

    if (previous.requestHash !== requestHash) {
      throw ApiException.conflict(
        ErrorCode.IDEMPOTENCY_KEY_REUSED,
        'Bu istek anahtarı farklı bir istek için kullanılmış.',
      );
    }

    if (!previous.completedAt || previous.responseBody === null) {
      throw ApiException.conflict(
        ErrorCode.CONFLICT,
        'Aynı istek şu anda işleniyor. Lütfen birkaç saniye sonra tekrar deneyin.',
      );
    }

    return previous.responseBody as T;
  }

  /** Suresi dolmus anahtarlari siler. Zamanlanmis gorev tarafindan cagirilir. */
  async purgeExpired(now: Date = new Date()): Promise<number> {
    const { count } = await this.prisma.idempotencyKey.deleteMany({
      where: { expiresAt: { lt: now } },
    });

    return count;
  }
}
