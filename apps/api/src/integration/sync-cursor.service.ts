/**
 * ToptanPortal API - Senkron Imleci Durumu
 *
 * Bir fark akisinin nerede kaldigini tutar ve ayni kanalin iki isleyici
 * tarafindan es zamanli calistirilmasini engeller.
 *
 * KILIT NEDEN GEREKLI: iki isleyici ayni imlecten okuyup ayni kayitlari isler,
 * sonra ikisi de imleci ilerletir. Islem sonucu ayni olsa bile Logo'ya iki kat
 * yuk biner ve - daha kotusu - biri hata alip imleci geri alirsa digerinin
 * ilerlettigi araliktaki kayitlar bir daha hic gelmez.
 *
 * Kilit SURESIZ degildir: isleyici surec cokerse kilit uzerinde kalir ve kanal
 * sonsuza dek durur. `staleSeconds` sonrasinda kilit devralinabilir.
 */

import { Injectable, Logger } from '@nestjs/common';
import { SyncChannel } from '@toptanportal/db';
import {
  SYNC_CHANNEL_LABELS,
  type SyncChannelState,
  type SyncChannel as SyncChannelContract,
} from '@toptanportal/contracts';

import { PrismaService } from '../common/prisma/prisma.service';

/** Kilidin devralinabilir sayilacagi sure. Bir tur bundan uzun surmemelidir. */
const KILIT_BAYATLAMA_SANIYE = 600;

export interface ClaimedCursor {
  id: string;
  channel: SyncChannel;
  cursor: string;
}

@Injectable()
export class SyncCursorService {
  private readonly logger = new Logger(SyncCursorService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Kiracinin dort kanal satirini garanti eder. `upsert` kullanilir: gecis
   * betigi mevcut kiracilar icin satirlari acar, sonradan olusan kiracilarda
   * ilk tur bu cagriyla tamamlar. Iki isleyici ayni anda cagirirsa unique
   * kisiti yarisi kaybedeni de dogru sonuca goturur.
   */
  async ensure(tenantId: string): Promise<void> {
    for (const channel of Object.values(SyncChannel)) {
      await this.prisma.syncCursor.upsert({
        where: { tenantId_channel: { tenantId, channel } },
        create: { tenantId, channel },
        update: {},
      });
    }
  }

  /**
   * Kanali kilitleyip imleci doner. Kanal kapaliysa veya baska bir isleyici
   * calisiyorsa null doner - cagiran taraf bunu hata SAYMAZ, sadece atlar.
   */
  async claim(
    tenantId: string,
    channel: SyncChannel,
    workerId: string,
  ): Promise<ClaimedCursor | null> {
    const bayatSinir = new Date(Date.now() - KILIT_BAYATLAMA_SANIYE * 1000);

    const { count } = await this.prisma.syncCursor.updateMany({
      where: {
        tenantId,
        channel,
        enabled: true,
        OR: [{ lockedAt: null }, { lockedAt: { lt: bayatSinir } }],
      },
      data: { lockedBy: workerId, lockedAt: new Date(), lastAttemptAt: new Date() },
    });

    if (count === 0) return null;

    const satir = await this.prisma.syncCursor.findUnique({
      where: { tenantId_channel: { tenantId, channel } },
      select: { id: true, channel: true, cursor: true, lockedBy: true },
    });

    /* Kilidi biz aldiysak satir bizimdir. Aradaki kisa pencerede baskasi
       devralmissa (bayat kilit yarisi) isi ona birakiriz. */
    if (!satir || satir.lockedBy !== workerId) return null;

    return { id: satir.id, channel: satir.channel, cursor: satir.cursor };
  }

  /**
   * Basarili tur. Imlec ilerletilir ve ardisik hata sayaci SIFIRLANIR: bir
   * kanal bir kez dogru calistiysa gecmisteki hatalar artik operatore bir sey
   * anlatmaz, yalnizca alarm yorgunlugu uretir.
   */
  async recordSuccess(id: string, cursor: string, itemCount: number): Promise<void> {
    await this.prisma.syncCursor.update({
      where: { id },
      data: {
        cursor,
        lastSuccessAt: new Date(),
        lastError: null,
        lastItemCount: itemCount,
        consecutiveFailures: 0,
        lockedBy: null,
        lockedAt: null,
      },
    });
  }

  /**
   * Basarisiz tur. IMLEC ILERLETILMEZ - eksik islenen aralik bir sonraki turda
   * bastan okunur. Fark akisinda atlanan kayit kendiliginden geri gelmez.
   */
  async recordFailure(id: string, error: string): Promise<void> {
    await this.prisma.syncCursor.update({
      where: { id },
      data: {
        lastError: error.slice(0, 1000),
        consecutiveFailures: { increment: 1 },
        lockedBy: null,
        lockedAt: null,
      },
    });
  }

  /** Imleci basa alir - yalnizca tam senkron istendiginde cagrilir. */
  async reset(tenantId: string, channel: SyncChannel): Promise<void> {
    await this.prisma.syncCursor.updateMany({
      where: { tenantId, channel },
      data: { cursor: '' },
    });

    this.logger.warn(`${channel} kanalının imleci sıfırlandı; tam senkron yapılacak.`);
  }

  async setEnabled(tenantId: string, channel: SyncChannel, enabled: boolean): Promise<void> {
    await this.prisma.syncCursor.updateMany({
      where: { tenantId, channel },
      data: { enabled, ...(enabled ? { consecutiveFailures: 0, lastError: null } : {}) },
    });
  }

  async list(tenantId: string): Promise<SyncChannelState[]> {
    const satirlar = await this.prisma.syncCursor.findMany({
      where: { tenantId },
      orderBy: { channel: 'asc' },
    });

    return satirlar.map((satir) => ({
      channel: satir.channel as SyncChannelContract,
      channelLabel: SYNC_CHANNEL_LABELS[satir.channel as SyncChannelContract],
      enabled: satir.enabled,
      lastSuccessAt: satir.lastSuccessAt?.toISOString() ?? null,
      lastAttemptAt: satir.lastAttemptAt?.toISOString() ?? null,
      lastError: satir.lastError,
      lastItemCount: satir.lastItemCount,
      consecutiveFailures: satir.consecutiveFailures,
    }));
  }
}
