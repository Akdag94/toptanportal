/**
 * ToptanPortal API - Katalog Yonetimi (portal -> Logo)
 *
 * Bu servis, portalin Logo'yu OKUMAKTAN yazmaya gectigi yerdir. Uc kural
 * dosyanin tamamini belirler:
 *
 * 1. YAZIM KUYRUKTAN GECER, dogrudan cagriyla degil. Kullanicinin kart acma
 *    islemi, koprunun o andaki erisilebilirligine bagli olmamalidir: sirket
 *    ici aga ulasilamadigi icin basarisiz olan bir kayit, kullaniciya
 *    "kaydedilmedi" der ve o kisi ayni karti bastan girer. Kart portale
 *    yazilir, `PENDING` isaretlenir ve isleyici Logo'ya tasir.
 *
 * 2. ALAN SAHIPLIGI KOKENDEN OKUNUR. Logo'da acilmis bir kartin adi, birimi ve
 *    KDV orani portalden degistirilemez; sunum alanlari (aciklama, gorsel,
 *    kategori) her kartta degistirilebilir cunku Logo onlari tutmaz.
 *
 * 3. TASLAK DOGAR. Yeni kart yayina dogrudan acilmaz: stogu ve fiyati henuz
 *    Logo'dan gelmemistir ve fiyatsiz bir urun, siparis edilip
 *    karsilanamayacak bir urundur.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  LogoWriteState,
  ProductOrigin,
  ProductStatus,
  type PrismaTransactionClient,
} from '@toptanportal/db';
import {
  AuditAction,
  ErrorCode,
  Permission,
  writableIdentityFields,
  type AdminProductPage,
  type AdminProductQuery,
  type AdminProductView,
  type ProductCreateRequest,
  type ProductUpdateRequest,
} from '@toptanportal/contracts';

import { ApiException } from '../common/exceptions/api.exception';
import { AuditService } from '../common/audit/audit.service';
import { OutboxService, OutboxEventType } from '../common/outbox/outbox.service';
import { PrismaService } from '../common/prisma/prisma.service';
import type { AuthenticatedPrincipal } from '../common/context/request-context';

const PRODUCT_INCLUDE = {
  units: { orderBy: { sortOrder: 'asc' } },
} as const;

type ProductWithUnits = Awaited<
  ReturnType<PrismaService['product']['findFirstOrThrow']>
> & {
  units: {
    id: string;
    code: string;
    name: string;
    conversionFactor: unknown;
    isBaseUnit: boolean;
    isDefaultForOrder: boolean;
  }[];
};

@Injectable()
export class CatalogAdminService {
  private readonly logger = new Logger(CatalogAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Listeleme
  // -------------------------------------------------------------------------

  async list(
    principal: AuthenticatedPrincipal,
    query: AdminProductQuery,
  ): Promise<AdminProductPage> {
    const where = {
      tenantId: principal.tenantId,
      ...(query.origin ? { origin: query.origin } : {}),
      ...(query.writeState ? { logoWriteState: query.writeState } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' as const } },
              { logoItemCode: { contains: query.q.toUpperCase() } },
            ],
          }
        : {}),
    };

    const [items, totalCount] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: PRODUCT_INCLUDE,
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        skip: query.offset,
        take: query.limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      items: items.map((urun) => this.toView(urun as ProductWithUnits)),
      totalCount,
      hasMore: query.offset + items.length < totalCount,
    };
  }

  // -------------------------------------------------------------------------
  // Olusturma
  // -------------------------------------------------------------------------

  async create(
    principal: AuthenticatedPrincipal,
    body: ProductCreateRequest,
  ): Promise<AdminProductView> {
    const kod = body.logoItemCode.toUpperCase();

    const mevcut = await this.prisma.product.findUnique({
      where: { tenantId_logoItemCode: { tenantId: principal.tenantId, logoItemCode: kod } },
      select: { id: true, name: true },
    });

    if (mevcut) {
      /* Ayni kodla ikinci kart acilamaz. "Var olani guncelle" davranisi
         BILINCLI olarak secilmedi: kullanici yeni bir urun actigini sanirken
         baska bir urunun adini ve birimini degistirmis olurdu - ve o urunun
         siparis gecmisi yeni adin altinda gorunurdu. */
      throw ApiException.conflict(
        ErrorCode.CONFLICT,
        `${kod} kodu zaten "${mevcut.name}" ürününde kullanılıyor. ` +
          'Stok kodu sonradan değiştirilemediği için farklı bir kod seçin.',
      );
    }

    const anaBirim = body.units.find((birim) => birim.isBaseUnit)!;

    const urun = await this.prisma.$transaction(async (tx) => {
      const olusan = await tx.product.create({
        data: {
          tenantId: principal.tenantId,
          logoItemCode: kod,
          name: body.name,
          description: body.description ?? null,
          brand: body.brand ?? null,
          categoryPath: body.categoryPath ?? null,
          imageUrl: body.imageUrl ?? null,
          baseUnitCode: anaBirim.code.toUpperCase(),
          baseUnitName: anaBirim.name,
          vatRate: body.vatRate,
          criticalStockThreshold: body.criticalStockThreshold,
          minOrderQuantity: body.minOrderQuantity,
          maxOrderQuantity: body.maxOrderQuantity ?? null,
          sortOrder: body.sortOrder,
          /* Kart TASLAK dogar. `publishImmediately` yalnizca Logo yazimi
             basarili olduktan SONRA anlam kazanir; isleyici yazimi
             tamamladiginda kart yayina alinir. Once yayina alip sonra
             yazmak, Logo'da olmayan bir urunu satisa acmaktir. */
          status: ProductStatus.DRAFT,
          origin: ProductOrigin.PORTAL,
          logoWriteState: LogoWriteState.PENDING,
          units: {
            create: body.units.map((birim, sira) => ({
              code: birim.code.toUpperCase(),
              name: birim.name,
              conversionFactor: birim.conversionFactor,
              isBaseUnit: birim.isBaseUnit,
              isDefaultForOrder: birim.isDefaultForOrder,
              sortOrder: sira,
            })),
          },
        },
        include: PRODUCT_INCLUDE,
      });

      await this.queueWrite(tx, principal.tenantId, olusan.id, {
        publishAfterWrite: body.publishImmediately,
      });

      await this.audit.record(
        {
          tenantId: principal.tenantId,
          action: AuditAction.PRODUCT_CREATED,
          resourceType: 'Product',
          resourceId: olusan.id,
          payload: {
            logoItemCode: kod,
            name: body.name,
            vatRate: body.vatRate,
            units: body.units.map((birim) => `${birim.code}:${birim.conversionFactor}`),
            publishImmediately: body.publishImmediately,
          },
        },
        tx,
      );

      return olusan;
    });

    this.logger.log(`${kod} kartı portalde açıldı; Logo'ya yazılmak üzere kuyruğa alındı.`);

    return this.toView(urun as ProductWithUnits);
  }

  // -------------------------------------------------------------------------
  // Guncelleme
  // -------------------------------------------------------------------------

  async update(
    principal: AuthenticatedPrincipal,
    productId: string,
    body: ProductUpdateRequest,
  ): Promise<AdminProductView> {
    const urun = await this.prisma.product.findFirst({
      where: { id: productId, tenantId: principal.tenantId },
      include: PRODUCT_INCLUDE,
    });

    if (!urun) {
      throw ApiException.notFound(ErrorCode.RESOURCE_NOT_FOUND, 'Ürün bulunamadı.');
    }

    this.assertIdentityEditable(urun.origin, body);

    /* Logo'yu ilgilendiren bir alan degistiyse kart yeniden yazilir. Sunum
       alanlari (aciklama, gorsel, kategori) Logo'da karsiligi olmadigi icin
       yazim TETIKLEMEZ: her gorsel degisikliginde Logo'ya kart yazmak,
       muhasebe sistemini portalin sunum tercihleriyle mesgul eder. */
    const logoyuEtkiler =
      body.name !== undefined || body.vatRate !== undefined || body.brand !== undefined;

    const guncel = await this.prisma.$transaction(async (tx) => {
      const sonuc = await tx.product.update({
        where: { id: urun.id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description ?? null } : {}),
          ...(body.brand !== undefined ? { brand: body.brand ?? null } : {}),
          ...(body.categoryPath !== undefined
            ? { categoryPath: body.categoryPath ?? null }
            : {}),
          ...(body.imageUrl !== undefined ? { imageUrl: body.imageUrl ?? null } : {}),
          ...(body.vatRate !== undefined ? { vatRate: body.vatRate } : {}),
          ...(body.criticalStockThreshold !== undefined
            ? { criticalStockThreshold: body.criticalStockThreshold }
            : {}),
          ...(body.minOrderQuantity !== undefined
            ? { minOrderQuantity: body.minOrderQuantity }
            : {}),
          ...(body.maxOrderQuantity !== undefined
            ? { maxOrderQuantity: body.maxOrderQuantity ?? null }
            : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
          ...(logoyuEtkiler ? { logoWriteState: LogoWriteState.PENDING } : {}),
        },
        include: PRODUCT_INCLUDE,
      });

      if (logoyuEtkiler) {
        await this.queueWrite(tx, principal.tenantId, urun.id, { publishAfterWrite: false });
      }

      await this.audit.record(
        {
          tenantId: principal.tenantId,
          action: AuditAction.PRODUCT_UPDATED,
          resourceType: 'Product',
          resourceId: urun.id,
          payload: {
            logoItemCode: urun.logoItemCode,
            /* Degisen alanlar ESKI ve YENI degeriyle yazilir. Yalnizca yeniyi
               yazmak, "neden degisti" sorusunu cevaplanamaz birakir: eski
               deger uzerine yazilmistir ve baska hicbir yerde durmaz. */
            changes: this.degisiklikOzeti(urun, body),
            logoRewriteQueued: logoyuEtkiler,
          },
        },
        tx,
      );

      return sonuc;
    });

    return this.toView(guncel as ProductWithUnits);
  }

  // -------------------------------------------------------------------------
  // Yardimcilar
  // -------------------------------------------------------------------------

  /**
   * Logo kokenli kartin KIMLIK alanlari portalden degistirilemez.
   *
   * Sema bu alanlari kabul eder; kabul etmesi gerekir cunku ayni sema PORTAL
   * kokenli kartta gecerlidir. Kural is katmanindadir ve reddetme mesaji NEDEN
   * oldugunu soyler - "geçersiz istek" diyen bir hata, kullaniciyi ayni seyi
   * tekrar denemeye iter.
   */
  private assertIdentityEditable(origin: ProductOrigin, body: ProductUpdateRequest): void {
    const yazilabilir = new Set(writableIdentityFields(origin));
    const denenen = (['name', 'brand', 'vatRate'] as const).filter(
      (alan) => body[alan] !== undefined && !yazilabilir.has(alan),
    );

    if (denenen.length === 0) return;

    throw ApiException.conflict(
      ErrorCode.CONFLICT,
      'Bu kart Logo’da açıldığı için adı, markası ve KDV oranı portalden değiştirilemez — ' +
        'muhasebecinin defterinde gördüğü ad, haberi olmadan değişmemelidir. ' +
        'Açıklama, görsel, kategori ve sipariş sınırları düzenlenebilir. ' +
        `Reddedilen alanlar: ${denenen.join(', ')}.`,
    );
  }

  /**
   * Kart yazimini kuyruga alir.
   *
   * Olay, is verisiyle AYNI islemde yazilir: kart kaydedilip olay yazilamazsa
   * kart Logo'ya hic gitmez ve portalde "Logo ile eşit" gorunur - iki sistemin
   * sessizce ayrisması tam olarak budur.
   */
  private async queueWrite(
    tx: PrismaTransactionClient,
    tenantId: string,
    productId: string,
    options: { publishAfterWrite: boolean },
  ): Promise<void> {
    await this.outbox.publish(tx, {
      tenantId,
      aggregateType: 'Product',
      aggregateId: productId,
      eventType: OutboxEventType.PRODUCT_UPSERTED,
      payload: { productId, publishAfterWrite: options.publishAfterWrite },
    });
  }

  private degisiklikOzeti(
    onceki: { name: string; vatRate: unknown; brand: string | null; status: string },
    body: ProductUpdateRequest,
  ): Record<string, { from: unknown; to: unknown }> {
    const ozet: Record<string, { from: unknown; to: unknown }> = {};

    if (body.name !== undefined && body.name !== onceki.name) {
      ozet.name = { from: onceki.name, to: body.name };
    }

    if (body.brand !== undefined && (body.brand ?? null) !== onceki.brand) {
      ozet.brand = { from: onceki.brand, to: body.brand ?? null };
    }

    if (body.vatRate !== undefined && Number(onceki.vatRate) !== body.vatRate) {
      ozet.vatRate = { from: Number(onceki.vatRate), to: body.vatRate };
    }

    if (body.status !== undefined && body.status !== onceki.status) {
      ozet.status = { from: onceki.status, to: body.status };
    }

    return ozet;
  }

  private toView(urun: ProductWithUnits): AdminProductView {
    return {
      id: urun.id,
      logoItemCode: urun.logoItemCode,
      name: urun.name,
      description: urun.description,
      brand: urun.brand,
      categoryPath: urun.categoryPath,
      imageUrl: urun.imageUrl,
      vatRate: Number(urun.vatRate),
      baseUnitCode: urun.baseUnitCode,
      units: urun.units.map((birim) => ({
        id: birim.id,
        code: birim.code,
        name: birim.name,
        conversionFactor: Number(birim.conversionFactor),
        isBaseUnit: birim.isBaseUnit,
        isDefaultForOrder: birim.isDefaultForOrder,
      })),
      criticalStockThreshold: Number(urun.criticalStockThreshold),
      minOrderQuantity: Number(urun.minOrderQuantity),
      maxOrderQuantity: urun.maxOrderQuantity === null ? null : Number(urun.maxOrderQuantity),
      sortOrder: urun.sortOrder,
      status: urun.status as AdminProductView['status'],
      origin: urun.origin,
      logoWriteState: urun.logoWriteState,
      logoWriteError: urun.logoWriteError,
      editableIdentityFields: [...writableIdentityFields(urun.origin)],
      lastSyncedAt: urun.logoSyncedAt?.toISOString() ?? null,
      updatedAt: urun.updatedAt.toISOString(),
    };
  }
}

/** Yetki sabiti, denetleyici ile servis arasinda tek yerde dursun. */
export const CATALOG_ADMIN_PERMISSION = Permission.CATALOG_MANAGE;
