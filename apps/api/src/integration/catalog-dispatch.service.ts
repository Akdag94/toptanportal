/**
 * ToptanPortal API - Katalog Aktarim Isleyicisi (portal -> Logo)
 *
 * Portalde acilan kart ve degistirilen fiyat, outbox'ta bekleyen olaylar
 * uzerinden Logo'ya tasinir. Siparis isleyicisiyle ayni kuyrugu paylasir ama
 * AYRI bir kanaldir (`CATALOG_WRITE`): katalog yazimi bekleyebilir, siparis
 * bekleyemez. Ikisini tek kanala koymak, bir fiyat degisikliginin arkasinda
 * bekleyen siparisi geciktirirdi - musteri fiyat degisikligini beklemez,
 * siparisinin gitmesini bekler.
 *
 * KART FIYATTAN ONCE yazilir ve bu sira kuyrugun kendisinden gelir: kart
 * olayi once yayinlanir, olaylar kimlik sirasina gore islenir. Fiyat, karti
 * Logo'da bulunmayan bir urun icin gonderilirse kopru `UNKNOWN_PRODUCT`
 * dondurur ve olay olu isaretlenir - operator once kart hatasini duzeltir.
 *
 * OLAYIN GOVDESI DEGIL, KAYDIN GUNCEL HALI gonderilir: olay yazildiktan sonra
 * kullanici ayni karti bir kez daha duzenlemis olabilir ve Logo'ya eski hali
 * gitmemelidir.
 */

import { Injectable, Logger } from '@nestjs/common';
import { AuditActorType, LogoWriteState, ProductStatus, SyncChannel } from '@toptanportal/db';
import { AuditAction } from '@toptanportal/contracts';

import { AuditService } from '../common/audit/audit.service';
import { OutboxService, OutboxEventType } from '../common/outbox/outbox.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { BridgeClient, BridgePermanentError } from './bridge.client';
import { SyncCursorService } from './sync-cursor.service';

/** Tek turda islenecek olay sayisi. Her olay bir ag cagrisidir. */
const TUR_BOYU = 20;

const KATALOG_OLAYLARI = [
  OutboxEventType.PRODUCT_UPSERTED,
  OutboxEventType.PRICE_CHANGED,
] as const;

@Injectable()
export class CatalogDispatchService {
  private readonly logger = new Logger(CatalogDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly bridge: BridgeClient,
    private readonly cursors: SyncCursorService,
    private readonly audit: AuditService,
  ) {}

  /** Bir tur calisir ve islenen olay sayisini doner. */
  async run(tenantId: string, workerId: string): Promise<number> {
    const claim = await this.cursors.claim(tenantId, SyncChannel.CATALOG_WRITE, workerId);
    if (!claim) return 0;

    let islenen = 0;

    try {
      const olaylar = await this.outbox.claimBatch(workerId, KATALOG_OLAYLARI, TUR_BOYU);

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

    if (olay.eventType === OutboxEventType.PRODUCT_UPSERTED) {
      await this.writeProduct(eventId, olay.aggregateId, olay.payload);
      return;
    }

    if (olay.eventType === OutboxEventType.PRICE_CHANGED) {
      await this.writePrice(eventId, olay.aggregateId);
      return;
    }

    /* Tanimadigi bir olayi BASARILI isaretlemek onu sessizce yutmaktir;
       kuyrukta birakmak sonsuz dongu uretir. */
    await this.outbox.markFailed(eventId, `Bilinmeyen olay türü: ${olay.eventType}`);
  }

  // -------------------------------------------------------------------------
  // Stok karti
  // -------------------------------------------------------------------------

  private async writeProduct(
    eventId: bigint,
    productId: string,
    payload: unknown,
  ): Promise<void> {
    const urun = await this.prisma.product.findUnique({
      where: { id: productId },
      include: { units: { orderBy: { sortOrder: 'asc' } } },
    });

    if (!urun) {
      /* Kart silinmis. Olay kapatilir: yazilacak bir sey yoktur ve kuyrukta
         tutmak, her turda ayni sorguyu tekrarlamaktir. */
      await this.outbox.markSent(eventId);
      return;
    }

    const yayinaAl =
      typeof payload === 'object' &&
      payload !== null &&
      (payload as { publishAfterWrite?: unknown }).publishAfterWrite === true;

    try {
      const sonuc = await this.bridge.pushItem({
        logoItemCode: urun.logoItemCode,
        name: urun.name,
        brand: urun.brand,
        vatRate: Number(urun.vatRate),
        units: urun.units.map((birim) => ({
          code: birim.code,
          name: birim.name,
          conversionFactor: Number(birim.conversionFactor),
          isBaseUnit: birim.isBaseUnit,
        })),
        /* Arsivlenmis kart Logo'da da satisa kapatilir. Portalde gizleyip
           Logo'da acik birakmak, plasiyerin Logo ekranindan hala satabilecegi
           bir urunu portalde yok gostermektir. */
        isActive: urun.status !== ProductStatus.ARCHIVED,
      });

      await this.prisma.product.update({
        where: { id: urun.id },
        data: {
          logoItemRef: sonuc.logoItemRef,
          logoWriteState: LogoWriteState.SYNCED,
          logoWriteError: null,
          logoSyncedAt: new Date(),
          /* Yayina alma yazim BASARILI olduktan sonra yapilir. Once yayina
             alip sonra yazmak, Logo'da olmayan bir urunu satisa acmaktir. */
          ...(yayinaAl && urun.status === ProductStatus.DRAFT
            ? { status: ProductStatus.PUBLISHED }
            : {}),
        },
      });

      await this.outbox.markSent(eventId);

      await this.audit.recordSafely({
        tenantId: urun.tenantId,
        action: AuditAction.LOGO_CATALOG_WRITTEN,
        actorType: AuditActorType.INTEGRATION,
        resourceType: 'Product',
        resourceId: urun.id,
        payload: {
          logoItemCode: urun.logoItemCode,
          logoItemRef: sonuc.logoItemRef,
          created: sonuc.created,
          published: yayinaAl && urun.status === ProductStatus.DRAFT,
        },
      });

      this.logger.log(
        `${urun.logoItemCode} kartı Logo'ya ${sonuc.created ? 'açıldı' : 'güncellendi'}.`,
      );
    } catch (error) {
      await this.handleFailure(eventId, error, {
        tenantId: urun.tenantId,
        resourceType: 'Product',
        resourceId: urun.id,
        label: urun.logoItemCode,
        onPermanent: (mesaj) =>
          this.prisma.product.update({
            where: { id: urun.id },
            data: { logoWriteState: LogoWriteState.FAILED, logoWriteError: mesaj },
          }),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Fiyat
  // -------------------------------------------------------------------------

  private async writePrice(eventId: bigint, priceListItemId: string): Promise<void> {
    const satir = await this.prisma.priceListItem.findUnique({
      where: { id: priceListItemId },
      include: {
        priceList: { select: { logoPriceListNo: true, currency: true, tenantId: true } },
        product: { select: { logoItemCode: true, baseUnitCode: true } },
        unit: { select: { code: true } },
      },
    });

    if (!satir) {
      await this.outbox.markSent(eventId);
      return;
    }

    try {
      await this.bridge.pushPrice({
        logoItemCode: satir.product.logoItemCode,
        priceListCode: String(satir.priceList.logoPriceListNo),
        /* Ana birim fiyatinda birim BOS gonderilir. Ana birimi ayrica birim
           bazli satir olarak yazmak, ayni fiyati iki kaynaktan tanimlar ve
           hangisinin kazandigi Logo surumune gore degisir. */
        unitCode: satir.unit?.code ?? null,
        minQuantity: Number(satir.minQuantity),
        price: Number(satir.price),
        currency: satir.priceList.currency,
        validFrom: satir.validFrom?.toISOString() ?? null,
        validTo: satir.validTo?.toISOString() ?? null,
      });

      await this.prisma.priceListItem.update({
        where: { id: satir.id },
        data: {
          logoWriteState: LogoWriteState.SYNCED,
          logoWriteError: null,
          logoSyncedAt: new Date(),
        },
      });

      await this.outbox.markSent(eventId);

      await this.audit.recordSafely({
        tenantId: satir.priceList.tenantId,
        action: AuditAction.LOGO_CATALOG_WRITTEN,
        actorType: AuditActorType.INTEGRATION,
        resourceType: 'PriceListItem',
        resourceId: satir.id,
        payload: {
          productCode: satir.product.logoItemCode,
          priceListNo: satir.priceList.logoPriceListNo,
          price: Number(satir.price),
        },
      });
    } catch (error) {
      await this.handleFailure(eventId, error, {
        tenantId: satir.priceList.tenantId,
        resourceType: 'PriceListItem',
        resourceId: satir.id,
        label: `${satir.product.logoItemCode} / liste ${satir.priceList.logoPriceListNo}`,
        onPermanent: (mesaj) =>
          this.prisma.priceListItem.update({
            where: { id: satir.id },
            data: { logoWriteState: LogoWriteState.FAILED, logoWriteError: mesaj },
          }),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Hata isleme
  // -------------------------------------------------------------------------

  /**
   * Iki yazim yolunun ORTAK hata davranisi.
   *
   * Gecici hatada kayit `PENDING` KALIR - kullaniciya "başarısız" gostermek,
   * birkac dakika sonra kendiliginden duzelecek bir durumu kalici bir kayip
   * gibi sunar. Kalici hatada durum `FAILED` olur, sebebi kaydin uzerine
   * yazilir ve operator o satiri ekranda gorur.
   *
   * Bildirimden farkli olarak burada deneme hakki tuketmek DOGRUDUR: reddedilen
   * bir kart ya da fiyat, tekrar denendiginde ayni yaniti alir ve kuyrugu
   * tikar. Duzeltmeyi yapacak olan insandir.
   */
  private async handleFailure(
    eventId: bigint,
    error: unknown,
    context: {
      tenantId: string;
      resourceType: string;
      resourceId: string;
      label: string;
      onPermanent: (mesaj: string) => Promise<unknown>;
    },
  ): Promise<void> {
    const mesaj = error instanceof Error ? error.message : 'bilinmeyen hata';
    const kalici = error instanceof BridgePermanentError;

    if (kalici) {
      await context.onPermanent(mesaj.slice(0, 1000));
      await this.outbox.markDead(eventId, mesaj);
    } else {
      await this.outbox.markFailed(eventId, mesaj);
    }

    await this.audit.recordSafely({
      tenantId: context.tenantId,
      action: AuditAction.LOGO_CATALOG_REJECTED,
      outcome: 'FAILURE',
      actorType: AuditActorType.INTEGRATION,
      resourceType: context.resourceType,
      resourceId: context.resourceId,
      payload: {
        label: context.label,
        permanent: kalici,
        reason: error instanceof BridgePermanentError ? error.reason : null,
        offendingCode: error instanceof BridgePermanentError ? error.offendingCode : null,
        message: mesaj.slice(0, 500),
      },
    });

    this.logger.error(
      `${context.label} Logo'ya yazılamadı (${kalici ? 'kalıcı' : 'geçici'}): ${mesaj}`,
    );
  }
}
