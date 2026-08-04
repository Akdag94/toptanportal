/**
 * ToptanPortal API - Siparis Aktarim Isleyicisi
 *
 * Outbox'ta bekleyen `order.placed` olaylarini alir ve kopru uzerinden Logo'ya
 * yazar. Isleyicinin tamami tek bir soru etrafinda kuruludur: "gonderdim mi?"
 *
 * Ag zaman asiminda cevap BILINMEZ - istek Logo'ya ulasmis ve fis olusmus, ama
 * yanit donerken baglanti kopmus olabilir. Bu yuzden tekrar deneme zorunludur
 * ve tekrar denemenin guvenli olmasi icin kopru `portalOrderId` uzerinden
 * idempotenttir: ayni kimlikle ikinci cagri yeni fis acmaz, ilkini doner.
 * Tekrar denemeyen bir isleyici siparis kaybeder; idempotent olmayan bir kopru
 * ile tekrar deneyen isleyici mukerrer fis uretir. Ikisi birlikte dogrudur.
 *
 * Olayin govdesi DEGIL, siparisin GUNCEL hali gonderilir: olay yazildiktan
 * sonra siparis onaylanmis veya iptal edilmis olabilir.
 */

import { Injectable, Logger } from '@nestjs/common';
import { AuditActorType, OrderStatus, OutboxStatus, SyncChannel } from '@toptanportal/db';
import { AuditAction } from '@toptanportal/contracts';

import { AuditService } from '../common/audit/audit.service';
import type { Decimal } from '../pricing/pricing.types';
import { OutboxService, OutboxEventType } from '../common/outbox/outbox.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { BridgeClient, BridgePermanentError } from './bridge.client';
import { SyncCursorService } from './sync-cursor.service';

/** Tek turda islenecek olay sayisi. Kucuk tutulur: her olay bir ag cagrisidir. */
const TUR_BOYU = 20;

/**
 * Bu isleyicinin ANLADIGI olaylar.
 *
 * Kuyruktan ayrim yapmadan cekmek, katalog olaylarini da bu isleyiciye
 * getirirdi; o da onlari "bilinmeyen olay türü" diyerek olu isaretlerdi ve
 * portalde acilan kart Logo'ya bir daha hic yazilmazdi.
 */
const SIPARIS_OLAYLARI = [OutboxEventType.ORDER_PLACED, OutboxEventType.ORDER_CANCELLED] as const;

@Injectable()
export class OrderDispatchService {
  private readonly logger = new Logger(OrderDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly bridge: BridgeClient,
    private readonly cursors: SyncCursorService,
    private readonly audit: AuditService,
  ) {}

  /** Bir tur calisir ve islenen olay sayisini doner. */
  async run(tenantId: string, workerId: string): Promise<number> {
    const claim = await this.cursors.claim(tenantId, SyncChannel.ORDER, workerId);
    if (!claim) return 0;

    let islenen = 0;

    try {
      const olaylar = await this.outbox.claimBatch(workerId, SIPARIS_OLAYLARI, TUR_BOYU);

      for (const { id } of olaylar) {
        await this.dispatch(id);
        islenen += 1;
      }

      await this.cursors.recordSuccess(claim.id, claim.cursor, islenen);
      return islenen;
    } catch (error) {
      const mesaj = error instanceof Error ? error.message : 'bilinmeyen hata';
      await this.cursors.recordFailure(claim.id, mesaj);
      throw error;
    }
  }

  private async dispatch(eventId: bigint): Promise<void> {
    const olay = await this.prisma.outboxEvent.findUnique({ where: { id: eventId } });
    if (!olay) return;

    if (olay.eventType === OutboxEventType.ORDER_CANCELLED) {
      /* Iptal olayi yalnizca KUYRUKTAKI siparis icin uretilir - yani Logo'ya
         henuz yazilmamis siparis icin. Logo'ya iletilecek bir sey yoktur:
         bekleyen `order.placed` olayi zaten iptal edilmis siparisi gormeyip
         gondermeden kapaniyor. Olay burada tamamlanmis sayilir.

         Logo'ya YAZILMIS bir siparis portalden iptal edilemez (bkz.
         OrderService.cancel); o iptal Logo'da elle yapilir. */
      await this.outbox.markSent(eventId);
      return;
    }

    if (olay.eventType !== OutboxEventType.ORDER_PLACED) {
      /* Bu isleyici yalnizca siparis olaylarini bilir. Tanimadigi bir olayi
         BASARILI isaretlemek onu sessizce yutmaktir; kuyrukta birakmak da
         sonsuz dongu uretir. Olu isaretlenir ve operatore gorunur. */
      await this.outbox.markFailed(eventId, `Bilinmeyen olay türü: ${olay.eventType}`);
      return;
    }

    const siparis = await this.prisma.order.findUnique({
      where: { id: olay.aggregateId },
      include: {
        company: { select: { logoCariCode: true } },
        warehouse: { select: { logoWarehouseNo: true } },
        lines: { orderBy: { lineNumber: 'asc' } },
      },
    });

    if (!siparis) {
      await this.outbox.markSent(eventId);
      this.logger.warn(`Sipariş bulunamadı, olay kapatıldı: ${olay.aggregateId}`);
      return;
    }

    /* Iptal edilmis siparis Logo'ya GONDERILMEZ. Olay yazildiktan sonra
       kullanici iptal etmis olabilir; kuyruk gecikmesi bir iptali geri
       alamaz. */
    if (siparis.status === OrderStatus.CANCELLED || siparis.status === OrderStatus.REJECTED) {
      await this.outbox.markSent(eventId);
      return;
    }

    /* Zaten aktarilmis siparis tekrar gonderilmez. Kopru idempotent olsa da
       gereksiz cagri, Logo'yu mesgul eder. */
    if (siparis.logoOrderNumber !== null) {
      await this.outbox.markSent(eventId);
      return;
    }

    await this.prisma.order.update({
      where: { id: siparis.id },
      data: { status: OrderStatus.SENDING },
    });

    try {
      const sonuc = await this.bridge.pushOrder({
        portalOrderId: siparis.id,
        orderNumber: siparis.orderNumber,
        companyLogoCode: siparis.company.logoCariCode,
        warehouseCode: String(siparis.warehouse.logoWarehouseNo),
        orderDate: siparis.submittedAt.toISOString(),
        deliveryDate: siparis.requestedDeliveryDate?.toISOString() ?? null,
        currency: siparis.currency,
        customerNote: siparis.customerNote,
        lines: siparis.lines.map((satir) => ({
          logoCode: satir.productCode,
          unitCode: satir.unitCode,
          quantity: Number(satir.quantity),
          unitPrice: Number(satir.unitPrice),
          discountRate: this.etkinIskontoOrani(satir.grossAmount, satir.discountTotal),
          vatRate: Number(satir.vatRate),
          lineNote: satir.note,
        })),
      });

      await this.prisma.$transaction(async (tx) => {
        await tx.order.update({
          where: { id: siparis.id },
          data: {
            status: OrderStatus.CONFIRMED,
            logoOrderNumber: sonuc.logoOrderNumber,
            logoOrderRef: sonuc.logoReference,
            logoError: null,
            sentToLogoAt: new Date(),
            confirmedAt: new Date(),
          },
        });

        await tx.orderStatusHistory.create({
          data: {
            orderId: siparis.id,
            fromStatus: OrderStatus.SENDING,
            toStatus: OrderStatus.CONFIRMED,
            reason: `Logo sipariş numarası: ${sonuc.logoOrderNumber}`,
          },
        });
      });

      await this.outbox.markSent(eventId);

      await this.audit.recordSafely({
        tenantId: siparis.tenantId,
        action: AuditAction.LOGO_SYNC_COMPLETED,
        actorType: AuditActorType.INTEGRATION,
        resourceType: 'Order',
        resourceId: siparis.id,
        companyId: siparis.companyId,
        payload: {
          orderNumber: siparis.orderNumber,
          logoOrderNumber: sonuc.logoOrderNumber,
          created: sonuc.created,
        },
      });
    } catch (error) {
      const mesaj = error instanceof Error ? error.message : 'bilinmeyen hata';
      const kalici = error instanceof BridgePermanentError;

      await this.prisma.order.update({
        where: { id: siparis.id },
        data: {
          /* Gecici hatada siparis KUYRUKTA kalir - kullaniciya "başarısız"
             gostermek, birkac dakika sonra kendiliginden duzelecek bir durumu
             kalici bir kayip gibi sunar. Kalici hatada durum FAILED olur ve
             operatorun mudahalesi beklenir. */
          status: kalici ? OrderStatus.FAILED : OrderStatus.QUEUED,
          logoError: mesaj.slice(0, 1000),
        },
      });

      if (kalici) {
        /* Olayi tukenmis say: tekrar denemek ayni sonucu verir ve kuyrugu
           tikar. Operator duzeltip elle yeniden kuyruga alir. */
        await this.outbox.markDead(eventId, mesaj);
      } else {
        await this.outbox.markFailed(eventId, mesaj);
      }

      await this.audit.recordSafely({
        tenantId: siparis.tenantId,
        action: AuditAction.LOGO_SYNC_FAILED,
        outcome: 'FAILURE',
        actorType: AuditActorType.INTEGRATION,
        resourceType: 'Order',
        resourceId: siparis.id,
        companyId: siparis.companyId,
        payload: {
          orderNumber: siparis.orderNumber,
          permanent: kalici,
          reason: error instanceof BridgePermanentError ? error.reason : null,
          offendingCode: error instanceof BridgePermanentError ? error.offendingCode : null,
          message: mesaj.slice(0, 500),
        },
      });

      this.logger.error(
        `${siparis.orderNumber} Logo'ya aktarılamadı (${kalici ? 'kalıcı' : 'geçici'}): ${mesaj}`,
      );
    }
  }

  /**
   * Zincirli iskontolari TEK bir etkin orana indirger.
   *
   * Logo siparis satiri tek indirim yuzdesi tasir; portalde ise kademe, kampanya
   * ve pazarlik iskontolari zincirlenebilir. Oranlari toplamak yanlistir
   * (%10 + %5, %15 etmez), bu yuzden tutardan geri hesaplanir - net tutar iki
   * tarafta ayni kalir. Zincirin dokumu portalde `appliedDiscounts` alaninda
   * durur ve ticari itiraz halinde ispat oradan yapilir.
   */
  private etkinIskontoOrani(grossAmount: Decimal, discountTotal: Decimal): number {
    const brut = Number(grossAmount);
    if (brut <= 0) return 0;

    const oran = (Number(discountTotal) / brut) * 100;
    return Math.min(Math.max(Number(oran.toFixed(4)), 0), 100);
  }

  /**
   * Olu olaylari yeniden kuyruga alir. Operator, Logo tarafinda eksik karti
   * actiktan sonra bu dugmeyi kullanir; deneme sayaci sifirlanmazsa olay ilk
   * denemede yeniden olu isaretlenir.
   */
  async retryDead(tenantId: string, eventIds?: string[]): Promise<number> {
    const { count } = await this.prisma.outboxEvent.updateMany({
      where: {
        tenantId,
        status: OutboxStatus.DEAD,
        ...(eventIds && eventIds.length > 0
          ? { id: { in: eventIds.map((id) => BigInt(id)) } }
          : {}),
      },
      data: {
        status: OutboxStatus.PENDING,
        attempts: 0,
        nextAttemptAt: new Date(),
        lastError: null,
        lockedBy: null,
        lockedAt: null,
      },
    });

    return count;
  }
}
