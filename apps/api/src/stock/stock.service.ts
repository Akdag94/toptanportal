/**
 * ToptanPortal - Stok Gorunurlugu ve Rezervasyon Defteri
 *
 * SERBEST STOK = onHand - logoReserved - portalReserved
 *   onHand         : Logo'daki fiziki stok (senkronizasyon kopyasi)
 *   logoReserved   : Logo tarafinda bekleyen siparisler (portal disi kanallar dahil)
 *   portalReserved : Portalde tutulan, henuz Logo'ya yazilmamis rezervler
 *
 * ES ZAMANLILIK: Rezervasyon daima `SELECT ... FOR UPDATE` ile satir kilitleyerek
 * yapilir. Iki bayi son 10 koliyi ayni saniyede isterse ikincisi kilidi bekler ve
 * guncel `portalReserved` degerini gorur - ayni stok iki kez satilamaz.
 *
 * KOR SIPARIS: Bu servis sayisal stok dondurur; sayiyi nitel duruma cevirmek ve
 * gizlemek cagiran katmanin (katalog/sepet) sorumlulugudur.
 */

import { Injectable } from '@nestjs/common';
import { ReservationStatus, type PrismaTransactionClient } from '@toptanportal/db';
import { ErrorCode, StockStatus, toStockStatus } from '@toptanportal/contracts';

import { ApiException } from '../common/exceptions/api.exception';
import { PrismaService } from '../common/prisma/prisma.service';
import { Decimal, quantity as quantityScale } from '../pricing/pricing.types';

/** Onay bekleyen siparisin rezervini sonsuza kadar tutmak stogu kilitler. */
const PENDING_APPROVAL_TTL_HOURS = 24;
/** Onaylanmis siparis Logo'ya yazilana kadar daha uzun tutulabilir. */
const QUEUED_TTL_HOURS = 72;

export interface FreeStockRow {
  productId: string;
  freeStock: Decimal;
  criticalThreshold: Decimal;
  status: StockStatus;
}

export interface ReservationRequest {
  productId: string;
  productName: string;
  unitCode: string;
  /** Ana birimde rezerve edilecek miktar */
  baseQuantity: Decimal;
  /** Kullaniciya hata mesajinda gosterilecek, secili birimdeki miktar */
  requestedQuantity: Decimal;
}

export interface StockShortageDetail {
  productId: string;
  productName: string;
  unitCode: string;
  requested: number;
  available: number;
}

/** Stok yetersizliginde firlatilir; kor modda `available` yanita eklenmez. */
export class StockShortageError extends Error {
  constructor(readonly shortages: StockShortageDetail[]) {
    super('Yetersiz stok.');
    this.name = 'StockShortageError';
  }
}

@Injectable()
export class StockService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Siparisin sevk edilecegi ambari belirler.
   * Acikca verilmisse o, degilse carinin varsayilani, o da yoksa kiracinin
   * varsayilan ambari kullanilir.
   */
  async resolveWarehouse(params: {
    tenantId: string;
    companyId: string;
    warehouseId?: string | null;
  }): Promise<{ id: string; name: string; logoWarehouseNo: number }> {
    const select = { id: true, name: true, logoWarehouseNo: true } as const;

    if (params.warehouseId) {
      const explicit = await this.prisma.warehouse.findFirst({
        where: { id: params.warehouseId, tenantId: params.tenantId, isActive: true },
        select,
      });

      if (!explicit) {
        throw ApiException.notFound(ErrorCode.RESOURCE_NOT_FOUND, 'Ambar bulunamadı.');
      }

      return explicit;
    }

    const company = await this.prisma.company.findFirst({
      where: { id: params.companyId, tenantId: params.tenantId },
      select: { defaultWarehouseNo: true },
    });

    if (!company) {
      throw ApiException.notFound(ErrorCode.RESOURCE_NOT_FOUND, 'İşletme bulunamadı.');
    }

    const preferred = await this.prisma.warehouse.findFirst({
      where: {
        tenantId: params.tenantId,
        logoWarehouseNo: company.defaultWarehouseNo,
        isActive: true,
      },
      select,
    });

    if (preferred) return preferred;

    const fallback = await this.prisma.warehouse.findFirst({
      where: { tenantId: params.tenantId, isDefault: true, isActive: true },
      select,
    });

    if (!fallback) {
      throw ApiException.notFound(
        ErrorCode.RESOURCE_NOT_FOUND,
        'Sevkiyat yapılabilecek aktif bir ambar tanımlı değil.',
      );
    }

    return fallback;
  }

  /**
   * Verilen urunlerin serbest stogunu tek sorguda getirir.
   * Stok kaydi olmayan urun "tukendi" sayilir - kaydin yoklugu, stogun
   * varligina delil degildir.
   */
  async getFreeStock(
    productIds: readonly string[],
    warehouseId: string,
  ): Promise<Map<string, FreeStockRow>> {
    if (productIds.length === 0) return new Map();

    const [snapshots, products] = await Promise.all([
      this.prisma.stockSnapshot.findMany({
        where: { warehouseId, productId: { in: [...productIds] } },
        select: {
          productId: true,
          onHand: true,
          logoReserved: true,
          portalReserved: true,
        },
      }),
      this.prisma.product.findMany({
        where: { id: { in: [...productIds] } },
        select: { id: true, criticalStockThreshold: true },
      }),
    ]);

    const thresholds = new Map(
      products.map((p) => [p.id, new Decimal(p.criticalStockThreshold)]),
    );
    const rows = new Map<string, FreeStockRow>();

    for (const productId of new Set(productIds)) {
      const snapshot = snapshots.find((s) => s.productId === productId);
      const threshold = thresholds.get(productId) ?? new Decimal(0);
      const freeStock = snapshot
        ? new Decimal(snapshot.onHand)
            .minus(snapshot.logoReserved)
            .minus(snapshot.portalReserved)
        : new Decimal(0);

      rows.set(productId, {
        productId,
        freeStock,
        criticalThreshold: threshold,
        status: toStockStatus(freeStock.toNumber(), threshold.toNumber()),
      });
    }

    return rows;
  }

  /**
   * Siparis icin stok ayirir. DAIMA bir islem (transaction) icinde cagirilir.
   *
   * Sira onemlidir: satirlar urun kimligine gore SIRALI kilitlenir. Iki es
   * zamanli siparis ayni iki urunu ters sirada kilitlerse olusacak kilitlenme
   * (deadlock) boylece imkansiz hale gelir.
   */
  async reserve(
    tx: PrismaTransactionClient,
    params: {
      orderId: string;
      warehouseId: string;
      requests: readonly ReservationRequest[];
      /** Onay bekleyen siparislerde rezerv kisa sure tutulur. */
      pendingApproval: boolean;
    },
  ): Promise<void> {
    const requests = [...params.requests].sort((a, b) => a.productId.localeCompare(b.productId));

    if (requests.length === 0) return;

    const shortages: StockShortageDetail[] = [];
    const ttlHours = params.pendingApproval ? PENDING_APPROVAL_TTL_HOURS : QUEUED_TTL_HOURS;
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

    for (const request of requests) {
      const locked = await tx.$queryRaw<
        { id: string; on_hand: string; logo_reserved: string; portal_reserved: string }[]
      >`
        SELECT id, "onHand" AS on_hand, "logoReserved" AS logo_reserved,
               "portalReserved" AS portal_reserved
        FROM stock_snapshots
        WHERE "productId" = ${request.productId}::uuid
          AND "warehouseId" = ${params.warehouseId}::uuid
        FOR UPDATE
      `;

      const row = locked[0];
      // Stok kaydinin yoklugu, o ambarda hic stok olmadigi anlamina gelir.
      const free = row
        ? new Decimal(row.on_hand).minus(row.logo_reserved).minus(row.portal_reserved)
        : new Decimal(0);

      if (!row || free.lessThan(request.baseQuantity)) {
        shortages.push({
          productId: request.productId,
          productName: request.productName,
          unitCode: request.unitCode,
          requested: request.requestedQuantity.toNumber(),
          available: quantityScale(free.lessThan(0) ? new Decimal(0) : free).toNumber(),
        });
        continue;
      }

      // Kilit alinmis satir uzerinde artir - okuma ile yazma arasinda baska
      // islem araya giremez.
      await tx.stockSnapshot.update({
        where: { id: row.id },
        data: { portalReserved: { increment: request.baseQuantity } },
      });

      await tx.stockReservation.create({
        data: {
          productId: request.productId,
          warehouseId: params.warehouseId,
          orderId: params.orderId,
          quantity: request.baseQuantity,
          status: ReservationStatus.HELD,
          expiresAt,
        },
      });
    }

    if (shortages.length > 0) {
      throw new StockShortageError(shortages);
    }
  }

  /**
   * Siparis iptal/red edildiginde veya rezervin suresi doldugunda stogu geri verir.
   * Idempotenttir: zaten serbest birakilmis rezervasyon tekrar dusulmez.
   */
  async release(
    tx: PrismaTransactionClient,
    orderId: string,
    reason: 'CANCELLED' | 'REJECTED' | 'EXPIRED' | 'SYNCED',
  ): Promise<number> {
    const held = await tx.stockReservation.findMany({
      where: { orderId, status: ReservationStatus.HELD },
      select: { id: true, productId: true, warehouseId: true, quantity: true },
      orderBy: { productId: 'asc' },
    });

    if (held.length === 0) return 0;

    // Logo'ya yazildiysa rezerv Logo tarafina gecti; portal sayaci dusulur ama
    // kayit "serbest birakildi" degil "senkronize edildi" olarak isaretlenir.
    const nextStatus =
      reason === 'SYNCED' ? ReservationStatus.SYNCED : ReservationStatus.RELEASED;

    for (const reservation of held) {
      await tx.stockSnapshot.updateMany({
        where: { productId: reservation.productId, warehouseId: reservation.warehouseId },
        data: { portalReserved: { decrement: reservation.quantity } },
      });
    }

    await tx.stockReservation.updateMany({
      where: { id: { in: held.map((r) => r.id) } },
      data: {
        status: nextStatus,
        releasedAt: nextStatus === ReservationStatus.RELEASED ? new Date() : null,
        syncedAt: nextStatus === ReservationStatus.SYNCED ? new Date() : null,
      },
    });

    return held.length;
  }

  /**
   * Suresi dolmus rezervasyonlari serbest birakir.
   * Zamanlanmis gorev tarafindan cagirilir; onay bekleyip unutulan siparisler
   * stogu sonsuza kadar kilitlemesin diye gereklidir.
   */
  async releaseExpired(now: Date = new Date()): Promise<number> {
    const expired = await this.prisma.stockReservation.findMany({
      where: { status: ReservationStatus.HELD, expiresAt: { lt: now } },
      select: { orderId: true },
      distinct: ['orderId'],
      take: 200,
    });

    let released = 0;

    for (const { orderId } of expired) {
      released += await this.prisma.$transaction((tx) => this.release(tx, orderId, 'EXPIRED'));
    }

    return released;
  }
}
