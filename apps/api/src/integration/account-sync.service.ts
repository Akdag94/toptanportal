/**
 * ToptanPortal API - Cari Hareket Fark Senkronu
 *
 * Logo'daki cari hareketleri portale AYNALAR. Otorite Logo'dur: portal bu
 * kayitlari yalnizca okur, uzerlerinde ticari karar uretmez.
 *
 * EslesTIRME ANAHTARI `logoFicheRef`tir, belge numarasi degildir. Logo'da belge
 * numarasi donem icinde tekrar edebilir (farkli fis turleri ayni numarayi
 * kullanabilir); numarayla eslestiren bir senkron, iki farkli hareketi tek
 * kayda cakistirir ve bakiyeyi bozar.
 *
 * FIS TURU ESLEMESI kuruluma BAGLIDIR. Asagidaki tablo Tiger/Go Wings
 * varsayilanlarina gore yazilmistir; her kurulumda musterinin fis turleriyle
 * DOGRULANMALIDIR. Bilinmeyen tur, borc/alacak yonune gore dekont sayilir -
 * hareketi atmak, bakiyeyi sessizce eksik birakir; yanlis etiketlemek ise
 * yalnizca gorunumu etkiler, tutari degil.
 */

import { Injectable, Logger } from '@nestjs/common';
import { AccountEntryKind, SyncChannel } from '@toptanportal/db';
import { SyncChannel as SyncChannelContract, type SyncRunResult } from '@toptanportal/contracts';

import { PrismaService } from '../common/prisma/prisma.service';
import { AccountService } from '../finance/account.service';
import { BridgeClient } from './bridge.client';
import { SyncCursorService } from './sync-cursor.service';

const AZAMI_SAYFA = 20;
const SAYFA_BOYU = 300;

/** Logo fis turu -> portal hareket turu. Kuruluma gore dogrulanmalidir. */
const FIS_TURU_ESLEMESI: Record<number, AccountEntryKind> = {
  8: AccountEntryKind.INVOICE, // Toptan satis faturasi
  7: AccountEntryKind.INVOICE, // Perakende satis faturasi
  3: AccountEntryKind.RETURN, // Toptan satis iade
  2: AccountEntryKind.RETURN, // Perakende satis iade
  31: AccountEntryKind.PAYMENT, // Tahsilat
  1: AccountEntryKind.OPENING, // Devir
};

@Injectable()
export class AccountSyncService {
  private readonly logger = new Logger(AccountSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bridge: BridgeClient,
    private readonly cursors: SyncCursorService,
    private readonly accounts: AccountService,
  ) {}

  async run(tenantId: string, workerId: string): Promise<SyncRunResult | null> {
    const claim = await this.cursors.claim(tenantId, SyncChannel.ACCOUNT, workerId);
    if (!claim) return null;

    const baslangic = Date.now();
    let imlec = claim.cursor;
    let toplam = 0;
    let devamVar = false;
    const etkilenenBayiler = new Set<string>();

    try {
      for (let sayfa = 0; sayfa < AZAMI_SAYFA; sayfa += 1) {
        const parca = await this.bridge.accountDelta(imlec, SAYFA_BOYU);

        if (parca.items.length > 0) {
          toplam += await this.apply(tenantId, parca.items, etkilenenBayiler);
        }

        imlec = parca.nextCursor;
        devamVar = parca.hasMore;
        await this.cursors.recordSuccess(claim.id, imlec, toplam);

        if (!devamVar) break;
      }

      /* Risk onbellegi hareketler yazildikTAN SONRA tazelenir. Once tazeleyip
         sonra yazmak, siparis kalkanina bir tur boyunca eski bakiyeyi
         gosterirdi. */
      for (const companyId of etkilenenBayiler) {
        await this.accounts.refreshRiskCache(companyId);
      }

      return {
        channel: SyncChannelContract.ACCOUNT,
        itemCount: toplam,
        durationMs: Date.now() - baslangic,
        hasMore: devamVar,
        cursor: imlec,
      };
    } catch (error) {
      const mesaj = error instanceof Error ? error.message : 'bilinmeyen hata';
      await this.cursors.recordFailure(claim.id, mesaj);
      this.logger.error(`Cari hareket senkronu başarısız: ${mesaj}`);
      throw error;
    }
  }

  private async apply(
    tenantId: string,
    items: {
      logoCode: string;
      ficheRef: number;
      documentNumber: string;
      documentType: number;
      entryDate: string;
      dueDate: string | null;
      debit: number;
      credit: number;
      description: string | null;
    }[],
    etkilenenBayiler: Set<string>,
  ): Promise<number> {
    const cariKodlari = [...new Set(items.map((item) => item.logoCode))];

    const bayiler = await this.prisma.company.findMany({
      where: { tenantId, logoCariCode: { in: cariKodlari } },
      select: { id: true, logoCariCode: true },
    });

    const bayiHaritasi = new Map(bayiler.map((bayi) => [bayi.logoCariCode, bayi.id]));

    let yazilan = 0;
    let atlanan = 0;

    for (const item of items) {
      const companyId = bayiHaritasi.get(item.logoCode);

      if (!companyId) {
        atlanan += 1;
        continue;
      }

      const kind = this.fisTuru(item.documentType, item.debit, item.credit);

      /* Alacak hareketinde `openAmount` sifirdir: tahsilat kapatilacak bir
         belge degildir, kapatan taraftir. */
      const openAmount = item.debit > 0 ? item.debit : 0;

      const veri = {
        kind,
        entryDate: new Date(item.entryDate),
        dueDate: item.dueDate ? new Date(item.dueDate) : null,
        documentNumber: item.documentNumber.slice(0, 32),
        description: item.description?.slice(0, 280) ?? null,
        debit: item.debit,
        credit: item.credit,
        logoSyncedAt: new Date(),
      };

      const mevcut = await this.prisma.accountEntry.findFirst({
        where: { tenantId, logoFicheRef: item.ficheRef },
        select: { id: true },
      });

      if (mevcut) {
        /* Var olan kaydin `openAmount` degeri KORUNUR: portalde yapilan
           tahsilat dagitimlari o alani dusurmustur, Logo'dan gelen ham belge
           tutariyla ezmek kapanmis borclari yeniden acar. */
        await this.prisma.accountEntry.update({ where: { id: mevcut.id }, data: veri });
      } else {
        await this.prisma.accountEntry.create({
          data: { tenantId, companyId, logoFicheRef: item.ficheRef, openAmount, ...veri },
        });
      }

      etkilenenBayiler.add(companyId);
      yazilan += 1;
    }

    if (atlanan > 0) {
      this.logger.log(
        `Cari senkronu: ${yazilan} hareket yazıldı, ${atlanan} hareket portalde bayi karşılığı olmadığı için atlandı.`,
      );
    }

    return yazilan;
  }

  private fisTuru(documentType: number, debit: number, credit: number): AccountEntryKind {
    const eslesme = FIS_TURU_ESLEMESI[documentType];
    if (eslesme) return eslesme;

    return debit > credit ? AccountEntryKind.DEBIT_NOTE : AccountEntryKind.CREDIT_NOTE;
  }
}
