/**
 * ToptanPortal - Transactional Outbox
 *
 * Siparis kaydi ile "Logo'ya gonder" olayi AYNI veritabani isleminde yazilir.
 * Boylece iki uctan biri asla eksik kalmaz:
 *   * Siparis yazildi ama olay yazilmadi -> siparis Logo'ya hic gitmez (kayip)
 *   * Olay yazildi ama siparis yazilmadi -> Logo'da hayalet siparis (mukerrer)
 * Kuyruk sunucusuna dogrudan yazmak bu garantiyi veremez; Logo veya kuyruk
 * bakimda oldugunda portal siparis almaya devam eder, olaylar birikir.
 */

import { Injectable } from '@nestjs/common';
import { OutboxStatus, Prisma, type PrismaTransactionClient } from '@toptanportal/db';

import { PrismaService } from '../prisma/prisma.service';

export const OutboxEventType = {
  ORDER_PLACED: 'order.placed',
  ORDER_CANCELLED: 'order.cancelled',
  /**
   * Stok karti portalde acildi veya duzenlendi; Logo'ya yazilmasi gerekiyor.
   *
   * Kart yazimi da outbox'tan gecer, dogrudan cagriyla degil: kullanicinin
   * kart acma islemi, Logo'nun (ya da koprunun) o andaki erisilebilirligine
   * bagli olmamalidir. Erisilemedigi icin basarisiz olan bir kayit, kullaniciya
   * "kaydedilmedi" der ve o kisi ayni karti bastan girer.
   */
  PRODUCT_UPSERTED: 'catalog.product.upserted',
  /** Fiyat portalde degistirildi; Logo'ya yazilmasi gerekiyor. */
  PRICE_CHANGED: 'catalog.price.changed',
} as const;

export type OutboxEventType = (typeof OutboxEventType)[keyof typeof OutboxEventType];

/**
 * Olayin isaret ettigi kayit turu.
 *
 * Serbest metin DEGILDIR: isleyiciler bu alana bakarak olayi tanir ve tanimadigi
 * olayi olu isaretler. Yazim hatasi tasiyan bir tur, olayin sessizce hicbir
 * isleyici tarafindan alinmamasina yol acardi.
 */
export type OutboxAggregateType = 'Order' | 'Product' | 'PriceListItem';

export interface OutboxEventInput {
  tenantId: string;
  aggregateType: OutboxAggregateType;
  aggregateId: string;
  eventType: OutboxEventType;
  payload: Prisma.InputJsonValue;
}

@Injectable()
export class OutboxService {
  constructor(private readonly prisma: PrismaService) {}

  /** Olayi cagiran islemin icinde yazar - islem geri alinirsa olay da silinir. */
  async publish(tx: PrismaTransactionClient, input: OutboxEventInput): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        tenantId: input.tenantId,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        eventType: input.eventType,
        payload: input.payload,
        status: OutboxStatus.PENDING,
      },
    });
  }

  /**
   * Isleyici (worker) icin: gonderilmeyi bekleyen olaylari kilitleyerek alir.
   * `FOR UPDATE SKIP LOCKED` sayesinde birden fazla isleyici ayni olayi
   * iki kez almaz; yatay olceklenme mumkun kalir.
   *
   * OLAY TURU ZORUNLUDUR. Her isleyici yalnizca ANLADIGI olayi alir; kuyruktan
   * ayrim yapmadan cekmek, siparis isleyicisinin bir katalog olayini alip
   * "bilinmeyen olay türü" diyerek OLU isaretlemesi demektir - olay bir daha
   * hic islenmez ve kart Logo'ya sonsuza kadar yazilmaz. Suzgeci cagiran
   * tarafa birakmak da yetmez: filtre unutuldugunda hata sessizdir ve ancak
   * bir kartin eksikligi fark edildiginde ortaya cikar.
   */
  async claimBatch(
    workerId: string,
    eventTypes: readonly OutboxEventType[],
    batchSize = 20,
  ): Promise<{ id: bigint }[]> {
    if (eventTypes.length === 0) return [];

    return this.prisma.$queryRaw<{ id: bigint }[]>`
      UPDATE outbox_events
      SET status = ${OutboxStatus.PROCESSING}::"OutboxStatus",
          "lockedBy" = ${workerId},
          "lockedAt" = NOW(),
          attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM outbox_events
        WHERE status = ${OutboxStatus.PENDING}::"OutboxStatus"
          AND "nextAttemptAt" <= NOW()
          AND "eventType" IN (${Prisma.join([...eventTypes])})
        ORDER BY id
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `;
  }

  /** Basarili gonderim. */
  async markSent(id: bigint): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id },
      data: { status: OutboxStatus.SENT, processedAt: new Date(), lockedBy: null, lockedAt: null },
    });
  }

  /**
   * Tekrar denenmesi ANLAMSIZ olan hata. Deneme hakki tuketilmeden dogrudan
   * olu isaretlenir.
   *
   * Ornek: Logo'da bulunmayan bir stok karti. On iki kez denemek ayni yaniti
   * alir, kuyrugu tikar ve gercek gecici hatalarin sirasini geciktirir.
   * Operator eksigi tamamlayip olayi elle yeniden kuyruga alir.
   */
  async markDead(id: bigint, error: string): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id },
      data: {
        status: OutboxStatus.DEAD,
        lastError: error.slice(0, 1000),
        lockedBy: null,
        lockedAt: null,
      },
    });
  }

  /**
   * Basarisiz gonderim. Ustel geri cekilme (exponential backoff) uygulanir;
   * azami deneme asilirsa olay DEAD isaretlenir ve manuel mudahale bekler -
   * sessizce kaybolmaz.
   */
  async markFailed(id: bigint, error: string): Promise<void> {
    const event = await this.prisma.outboxEvent.findUnique({
      where: { id },
      select: { attempts: true, maxAttempts: true },
    });

    if (!event) return;

    const exhausted = event.attempts >= event.maxAttempts;
    const backoffSeconds = Math.min(2 ** event.attempts * 30, 3600);

    await this.prisma.outboxEvent.update({
      where: { id },
      data: {
        status: exhausted ? OutboxStatus.DEAD : OutboxStatus.PENDING,
        nextAttemptAt: new Date(Date.now() + backoffSeconds * 1000),
        lastError: error.slice(0, 1000),
        lockedBy: null,
        lockedAt: null,
      },
    });
  }
}
