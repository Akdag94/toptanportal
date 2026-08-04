/**
 * ToptanPortal API - Fiyat Degistirme (portal -> Logo)
 *
 * Bu servis, portalin uzun sure BILINCLI olarak yapmadigi seyi yapar: fiyati
 * degistirir. Eski gerekce dogruydu ve bugun de gecerlidir - portalde tutulup
 * Logo'ya yazilmayan bir fiyat, bir sonraki senkronda sessizce geri alinir.
 * Cozum fiyati portalde tutmak degil, DEGISIKLIGI LOGO'YA TASIMAKTIR: kayit
 * portale yazilir, kuyruga alinir ve Logo'ya gecer; senkron o degeri geri
 * okudugunda iki taraf zaten aynidir.
 *
 * Yazim tamamlanana kadar satir `PENDING` isaretlidir ve ekran bunu gosterir.
 * Bu isaret olmasaydi kullanici yeni fiyati gorup isinin bittigini sanardi;
 * fiyat farki ancak fatura kesildikten sonra fark edilirdi.
 */

import { Injectable, Logger } from '@nestjs/common';
import { LogoWriteState } from '@toptanportal/db';
import {
  AuditAction,
  ErrorCode,
  type PriceChangeRequest,
  type PriceListItemView,
} from '@toptanportal/contracts';

import { ApiException } from '../common/exceptions/api.exception';
import { AuditService } from '../common/audit/audit.service';
import { OutboxService, OutboxEventType } from '../common/outbox/outbox.service';
import { PrismaService } from '../common/prisma/prisma.service';
import type { AuthenticatedPrincipal } from '../common/context/request-context';

@Injectable()
export class PriceChangeService {
  private readonly logger = new Logger(PriceChangeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  async change(
    principal: AuthenticatedPrincipal,
    body: PriceChangeRequest,
  ): Promise<PriceListItemView> {
    const [liste, urun] = await Promise.all([
      this.prisma.priceList.findFirst({
        where: { id: body.priceListId, tenantId: principal.tenantId },
        select: { id: true, logoPriceListNo: true, name: true, currency: true, isActive: true },
      }),
      this.prisma.product.findFirst({
        where: { id: body.productId, tenantId: principal.tenantId },
        select: {
          id: true,
          logoItemCode: true,
          name: true,
          baseUnitCode: true,
          units: { select: { id: true, code: true } },
        },
      }),
    ]);

    if (!liste) {
      throw ApiException.notFound(ErrorCode.RESOURCE_NOT_FOUND, 'Fiyat listesi bulunamadı.');
    }

    if (!urun) {
      throw ApiException.notFound(ErrorCode.RESOURCE_NOT_FOUND, 'Ürün bulunamadı.');
    }

    if (!liste.isActive) {
      /* Pasif listeye fiyat yazmak, hicbir bayiyi etkilemeyen bir degisikligi
         yapilmis gibi gostermektir. Kullanici fiyati degistirdigini sanir,
         siparisler eski listeden gelmeye devam eder. */
      throw ApiException.conflict(
        ErrorCode.CONFLICT,
        `"${liste.name}" listesi pasif durumda; fiyat değişikliği hiçbir bayiyi etkilemez.`,
      );
    }

    const unitId = body.unitId ?? null;
    const birim = unitId === null ? null : urun.units.find((satir) => satir.id === unitId);

    if (unitId !== null && !birim) {
      throw ApiException.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Seçilen birim bu ürüne ait değil.',
      );
    }

    /* `upsert` KULLANILAMAZ: bilesik benzersiz kisit nullable `unitId` icerir
       ve Prisma'nin `where` tipi null kabul etmez. Ana birim fiyatlari tam
       olarak bu null durumudur - yani en sik gecen hal. */
    const mevcut = await this.prisma.priceListItem.findFirst({
      where: {
        priceListId: liste.id,
        productId: urun.id,
        unitId,
        minQuantity: body.minQuantity,
      },
      select: { id: true, price: true },
    });

    const oncekiFiyat = mevcut ? mevcut.price.toNumber() : null;

    const veri = {
      price: body.price,
      validFrom: body.validFrom ? new Date(body.validFrom) : null,
      validTo: body.validTo ? new Date(body.validTo) : null,
      logoWriteState: LogoWriteState.PENDING,
      logoWriteError: null,
    };

    const satir = await this.prisma.$transaction(async (tx) => {
      const sonuc = mevcut
        ? await tx.priceListItem.update({
            where: { id: mevcut.id },
            data: veri,
            include: { product: true, unit: true },
          })
        : await tx.priceListItem.create({
            data: {
              priceListId: liste.id,
              productId: urun.id,
              unitId,
              minQuantity: body.minQuantity,
              ...veri,
            },
            include: { product: true, unit: true },
          });

      await this.outbox.publish(tx, {
        tenantId: principal.tenantId,
        aggregateType: 'PriceListItem',
        aggregateId: sonuc.id,
        eventType: OutboxEventType.PRICE_CHANGED,
        payload: { priceListItemId: sonuc.id },
      });

      await this.audit.record(
        {
          tenantId: principal.tenantId,
          action: AuditAction.PRICE_CHANGED,
          resourceType: 'PriceListItem',
          resourceId: sonuc.id,
          payload: {
            priceListNo: liste.logoPriceListNo,
            priceListName: liste.name,
            productCode: urun.logoItemCode,
            productName: urun.name,
            unitCode: birim?.code ?? urun.baseUnitCode,
            minQuantity: body.minQuantity,
            currency: liste.currency,
            /* ESKI ve YENI birlikte yazilir. Yalnizca yeniyi yazmak, "bana
               neden bu fiyattan kesildi" sorusunu cevaplanamaz birakir: eski
               deger uzerine yazilmistir ve baska hicbir yerde durmaz. */
            previousPrice: oncekiFiyat,
            newPrice: body.price,
            created: mevcut === null,
            reason: body.reason,
          },
        },
        tx,
      );

      return sonuc;
    });

    this.logger.log(
      `${urun.logoItemCode} fiyatı ${liste.name} listesinde ` +
        `${oncekiFiyat ?? '—'} → ${body.price} olarak değiştirildi; Logo'ya yazılmak üzere kuyruğa alındı.`,
    );

    return {
      id: satir.id,
      productId: satir.productId,
      productCode: satir.product.logoItemCode,
      productName: satir.product.name,
      unitId: satir.unitId,
      unitCode: satir.unit?.code ?? null,
      price: satir.price.toNumber(),
      minQuantity: satir.minQuantity.toNumber(),
      validFrom: satir.validFrom?.toISOString() ?? null,
      validTo: satir.validTo?.toISOString() ?? null,
      logoWriteState: satir.logoWriteState,
      logoWriteError: satir.logoWriteError,
      lastSyncedAt: satir.logoSyncedAt?.toISOString() ?? null,
    };
  }
}
