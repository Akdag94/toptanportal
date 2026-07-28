/**
 * ToptanPortal API - Stok Fark Senkronu
 *
 * Logo'daki fiili stogu portale tasir. Uc kural bu dosyanin tamamini belirler:
 *
 * 1. `portalReserved` ASLA Logo'dan gelen veriyle ezilmez. O alan portalin
 *    kendi rezervasyonlarinin toplamidir; Logo onu bilmez. Ezilirse, henuz
 *    Logo'ya yansimamis siparislerin stogu ikinci kez satilir.
 *
 * 2. Portalde karsiligi olmayan stok kodu HATA DEGILDIR. Logo'da portalde
 *    satilmayan yuzlerce kart bulunur; her birini hata sayan bir akis, gercek
 *    hatayi gurultuye gomer. Atlananlar sayilir ve toplu olarak raporlanir.
 *
 * 3. Tur, kismi ilerlemeyi KORUR. Sayfa sayfa yazilir; bir sayfa hata verirse
 *    onceki sayfalarin imleci saklidir. Tum turu tek isleme almak, 40 bin
 *    satirlik ilk senkronu tek bir ag hatasinda bastan aldirir.
 */

import { Injectable, Logger } from '@nestjs/common';
import { SyncChannel } from '@toptanportal/db';
import { SyncChannel as SyncChannelContract, type SyncRunResult } from '@toptanportal/contracts';

import { PrismaService } from '../common/prisma/prisma.service';
import { BridgeClient } from './bridge.client';
import { SyncCursorService } from './sync-cursor.service';

/** Tek turda islenecek azami sayfa. Tur suresini sinirlar. */
const AZAMI_SAYFA = 20;
const SAYFA_BOYU = 500;

@Injectable()
export class StockSyncService {
  private readonly logger = new Logger(StockSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bridge: BridgeClient,
    private readonly cursors: SyncCursorService,
  ) {}

  async run(tenantId: string, workerId: string): Promise<SyncRunResult | null> {
    const claim = await this.cursors.claim(tenantId, SyncChannel.STOCK, workerId);
    if (!claim) return null;

    const baslangic = Date.now();
    let imlec = claim.cursor;
    let toplam = 0;
    let devamVar = false;

    try {
      for (let sayfa = 0; sayfa < AZAMI_SAYFA; sayfa += 1) {
        const parca = await this.bridge.stockDelta(imlec, SAYFA_BOYU);

        if (parca.items.length > 0) {
          toplam += await this.apply(tenantId, parca.items);
        }

        imlec = parca.nextCursor;
        devamVar = parca.hasMore;

        /* Imlec her sayfadan sonra yazilir. Uzun bir ilk senkron sirasinda
           surec yeniden baslarsa, kalinan yerden devam edilir. */
        await this.cursors.recordSuccess(claim.id, imlec, toplam);

        if (!devamVar) break;
      }

      return {
        channel: SyncChannelContract.STOCK,
        itemCount: toplam,
        durationMs: Date.now() - baslangic,
        hasMore: devamVar,
        cursor: imlec,
      };
    } catch (error) {
      const mesaj = error instanceof Error ? error.message : 'bilinmeyen hata';
      await this.cursors.recordFailure(claim.id, mesaj);
      this.logger.error(`Stok senkronu başarısız: ${mesaj}`);
      throw error;
    }
  }

  /**
   * Gelen satirlari yazar ve YAZILAN sayisini doner.
   *
   * Urun ve ambar eslesmeleri tek sorguda toplu cekilir: satir basina sorgu,
   * 500 satirlik bir sayfada 1000 gidis-donus demektir ve senkronu ag
   * gecikmesine bagimli hale getirir.
   */
  private async apply(
    tenantId: string,
    items: { logoCode: string; warehouseCode: string; onHand: number; allocated: number }[],
  ): Promise<number> {
    const stokKodlari = [...new Set(items.map((item) => item.logoCode))];
    const ambarNolari = [
      ...new Set(
        items
          .map((item) => Number.parseInt(item.warehouseCode, 10))
          .filter((no) => Number.isInteger(no)),
      ),
    ];

    const [urunler, ambarlar] = await Promise.all([
      this.prisma.product.findMany({
        where: { tenantId, logoItemCode: { in: stokKodlari } },
        select: { id: true, logoItemCode: true },
      }),
      this.prisma.warehouse.findMany({
        where: { tenantId, logoWarehouseNo: { in: ambarNolari } },
        select: { id: true, logoWarehouseNo: true },
      }),
    ]);

    const urunHaritasi = new Map(urunler.map((urun) => [urun.logoItemCode, urun.id]));
    const ambarHaritasi = new Map(
      ambarlar.map((ambar) => [ambar.logoWarehouseNo, ambar.id]),
    );

    let yazilan = 0;
    let atlanan = 0;

    for (const item of items) {
      const productId = urunHaritasi.get(item.logoCode);
      const warehouseId = ambarHaritasi.get(Number.parseInt(item.warehouseCode, 10));

      if (!productId || !warehouseId) {
        atlanan += 1;
        continue;
      }

      /* `portalReserved` create'te sifirdir, update'te HIC DOKUNULMAZ -
         Logo bu alani bilmez, bildigini varsaymak stogu iki kez sattirir. */
      await this.prisma.stockSnapshot.upsert({
        where: { productId_warehouseId: { productId, warehouseId } },
        create: {
          productId,
          warehouseId,
          onHand: item.onHand,
          logoReserved: item.allocated,
          logoSyncedAt: new Date(),
        },
        update: {
          onHand: item.onHand,
          logoReserved: item.allocated,
          logoSyncedAt: new Date(),
        },
      });

      yazilan += 1;
    }

    if (atlanan > 0) {
      this.logger.log(
        `Stok senkronu: ${yazilan} satır yazıldı, ${atlanan} satır portalde karşılığı olmadığı için atlandı.`,
      );
    }

    return yazilan;
  }
}
