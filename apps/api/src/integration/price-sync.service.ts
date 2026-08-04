/**
 * ToptanPortal API - Fiyat Fark Senkronu
 *
 * Logo'daki fiyat kartlarini portale tasir. Fiyat, stoktan farkli olarak
 * TICARI SONUC uretir: yanlis senkronlanan bir fiyat, yanlis kesilen bir
 * faturaya doner. Bu yuzden burada iki ek koruma vardir:
 *
 *   * Portalde karsiligi olmayan fiyat listesi OLUSTURULMAZ. Liste tanimi
 *     ticari bir karardir (hangi bayi hangi listeden alir); Logo'dan gelen
 *     numaraya bakip kendiliginden liste acmak, kimsenin onaylamadigi bir
 *     fiyat setini portale sokar.
 *   * Negatif fiyat yazilmaz. Logo tarafinda veri girisi hatasiyla olusabilir;
 *     portalde negatif birim fiyat, siparis toplamini eksiye cevirir.
 *   * PORTALDE BEKLEYEN BIR DEGISIKLIGIN USTUNE YAZILMAZ. Portal artik fiyati
 *     Logo'ya yazabildigi icin, kuyrukta bekleyen bir degisiklik Logo'ya
 *     ulasmadan once bu akis calisabilir; gelen deger o degisiklikten
 *     oncesine aittir. Ustune yazmak, kullanicinin biraz once yaptigi
 *     degisikligi sessizce geri almaktir - kural `catalog-ownership.ts`
 *     icindedir.
 */

import { Injectable, Logger } from '@nestjs/common';
import { LogoWriteState, SyncChannel } from '@toptanportal/db';
import { SyncChannel as SyncChannelContract, type SyncRunResult } from '@toptanportal/contracts';

import { PrismaService } from '../common/prisma/prisma.service';
import { BridgeClient } from './bridge.client';
import { logoDegeriYazilabilir } from './catalog-ownership';
import { SyncCursorService } from './sync-cursor.service';

const AZAMI_SAYFA = 20;
const SAYFA_BOYU = 500;

@Injectable()
export class PriceSyncService {
  private readonly logger = new Logger(PriceSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bridge: BridgeClient,
    private readonly cursors: SyncCursorService,
  ) {}

  async run(tenantId: string, workerId: string): Promise<SyncRunResult | null> {
    const claim = await this.cursors.claim(tenantId, SyncChannel.PRICE, workerId);
    if (!claim) return null;

    const baslangic = Date.now();
    let imlec = claim.cursor;
    let toplam = 0;
    let devamVar = false;

    try {
      for (let sayfa = 0; sayfa < AZAMI_SAYFA; sayfa += 1) {
        const parca = await this.bridge.priceDelta(imlec, SAYFA_BOYU);

        if (parca.items.length > 0) {
          toplam += await this.apply(tenantId, parca.items);
        }

        imlec = parca.nextCursor;
        devamVar = parca.hasMore;
        await this.cursors.recordSuccess(claim.id, imlec, toplam);

        if (!devamVar) break;
      }

      return {
        channel: SyncChannelContract.PRICE,
        itemCount: toplam,
        durationMs: Date.now() - baslangic,
        hasMore: devamVar,
        cursor: imlec,
      };
    } catch (error) {
      const mesaj = error instanceof Error ? error.message : 'bilinmeyen hata';
      await this.cursors.recordFailure(claim.id, mesaj);
      this.logger.error(`Fiyat senkronu başarısız: ${mesaj}`);
      throw error;
    }
  }

  private async apply(
    tenantId: string,
    items: {
      logoCode: string;
      priceListCode: string;
      unitCode: string;
      price: number;
      validFrom: string | null;
      validTo: string | null;
    }[],
  ): Promise<number> {
    const stokKodlari = [...new Set(items.map((item) => item.logoCode))];
    const listeNolari = [
      ...new Set(
        items
          .map((item) => Number.parseInt(item.priceListCode, 10))
          .filter((no) => Number.isInteger(no)),
      ),
    ];

    const [urunler, listeler] = await Promise.all([
      this.prisma.product.findMany({
        where: { tenantId, logoItemCode: { in: stokKodlari } },
        select: {
          id: true,
          logoItemCode: true,
          baseUnitCode: true,
          units: { select: { id: true, code: true } },
        },
      }),
      this.prisma.priceList.findMany({
        where: { tenantId, logoPriceListNo: { in: listeNolari } },
        select: { id: true, logoPriceListNo: true },
      }),
    ]);

    const urunHaritasi = new Map(urunler.map((urun) => [urun.logoItemCode, urun]));
    const listeHaritasi = new Map(listeler.map((liste) => [liste.logoPriceListNo, liste.id]));

    let yazilan = 0;
    let atlanan = 0;
    let korunan = 0;

    for (const item of items) {
      const urun = urunHaritasi.get(item.logoCode);
      const priceListId = listeHaritasi.get(Number.parseInt(item.priceListCode, 10));

      if (!urun || !priceListId || item.price < 0) {
        atlanan += 1;
        continue;
      }

      /* Fiyat ana birimde geliyorsa `unitId` null birakilir; diger birimlerin
         fiyati cevrim katsayisiyla hesaplanir. Ana birimi ayrica satir olarak
         yazmak, ayni fiyati iki kaynaktan tanimlamak olur. */
      const unitId =
        item.unitCode === urun.baseUnitCode
          ? null
          : (urun.units.find((birim) => birim.code === item.unitCode)?.id ?? null);

      if (unitId === null && item.unitCode !== urun.baseUnitCode) {
        atlanan += 1;
        continue;
      }

      /* `upsert` KULLANILAMAZ: bilesik benzersiz kisit nullable `unitId`
         icerdigi icin Prisma'nin `where` tipi null kabul etmez. Ana birim
         fiyatlari tam olarak bu null durumudur - yani en sik gecen hal.
         Kanal kilidi sayesinde bu kanalda tek isleyici calisir; oku-yaz
         araligi yarisa acik degildir. */
      const veri = {
        price: item.price,
        validFrom: item.validFrom ? new Date(item.validFrom) : null,
        validTo: item.validTo ? new Date(item.validTo) : null,
        logoSyncedAt: new Date(),
      };

      const mevcut = await this.prisma.priceListItem.findFirst({
        where: { priceListId, productId: urun.id, unitId, minQuantity: 0 },
        select: { id: true, logoWriteState: true },
      });

      if (mevcut) {
        if (!logoDegeriYazilabilir(mevcut.logoWriteState)) {
          /* Portalde bekleyen ya da reddedilmis bir degisiklik var. Gelen
             deger o degisiklikten oncesine aittir; ustune yazmak kullanicinin
             degisikligini geri almak, hata isaretini de temizlemek olurdu. */
          korunan += 1;
          continue;
        }

        await this.prisma.priceListItem.update({ where: { id: mevcut.id }, data: veri });
      } else {
        await this.prisma.priceListItem.create({
          data: { priceListId, productId: urun.id, unitId, ...veri },
        });
      }

      yazilan += 1;
    }

    if (atlanan > 0 || korunan > 0) {
      this.logger.log(
        `Fiyat senkronu: ${yazilan} satır yazıldı, ${atlanan} satır eşleşmediği veya ` +
          `geçersiz olduğu için atlandı, ${korunan} satır portalde bekleyen değişiklik ` +
          'nedeniyle korundu.',
      );
    }

    return yazilan;
  }
}
