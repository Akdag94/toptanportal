/**
 * ToptanPortal API - Toplu Siparis Ice Aktarimi
 *
 * Bayilerin cogu siparisini hala Excel'de tutar. Bu servis o dosyayi sepete
 * cevirir ve boylece portalin benimsenmesi, calisma aliskanliginin
 * degismesine BAGLI OLMAKTAN cikar.
 *
 * SATIR AYRISTIRMA KURALLARI - hepsi gercek dosyalardan gelen sorunlardir:
 *
 *  * Ayrac noktali virgul, virgul veya sekme olabilir. Turkce Excel varsayilan
 *    olarak noktali virgulle kaydeder ama kullanici dosyayi bir yerden
 *    kopyalamis olabilir.
 *  * Miktarda ondalik ayraci virgul de olabilir nokta da ("1,5" ve "1.5" ayni
 *    seydir). Binlik ayraci ise ATILIR - "1.250" bin iki yuz elli demektir,
 *    bir virgul iki degil.
 *  * Basliksatiri sessizce atlanir: "Stok Kodu;Adet" yazan ilk satir, sayiya
 *    cevrilemedigi icin zaten hataya duser - ama bunu KULLANICIYA HATA olarak
 *    gostermek, dosyasi dogru olan kisiyi bosuna telaslandirir.
 *
 * ESLESMEYEN SATIR SESSIZCE ATLANMAZ. Kullanici 40 satirlik dosyasini
 * yukleyip 37 kalem sepet gordugunde, eksik ucunu ARAMAK zorunda kalmamalidir.
 */

import { Injectable } from '@nestjs/common';
import { ProductStatus } from '@toptanportal/db';
import { ErrorCode, type BulkImportResult, type CartView } from '@toptanportal/contracts';

import { ApiException } from '../common/exceptions/api.exception';
import { CartService, type CartOwner } from './cart.service';
import { PrismaService } from '../common/prisma/prisma.service';

/** Tek dosyada islenecek azami satir. */
const AZAMI_SATIR = 1000;

interface AyristirilmisSatir {
  satirNo: number;
  stokKodu: string;
  miktar: number;
  ham: string;
}

@Injectable()
export class BulkImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cart: CartService,
  ) {}

  async import(
    owner: CartOwner,
    tenantId: string,
    content: string,
    replaceExisting: boolean,
  ): Promise<BulkImportResult> {
    const { satirlar, hataliSatirlar } = this.ayristir(content);

    if (satirlar.length === 0) {
      throw ApiException.unprocessable(
        ErrorCode.VALIDATION_FAILED,
        'Dosyada okunabilir satır bulunamadı. Beklenen biçim: "StokKodu;Miktar"',
      );
    }

    const kodlar = [...new Set(satirlar.map((satir) => satir.stokKodu))];

    const urunler = await this.prisma.product.findMany({
      where: { tenantId, logoItemCode: { in: kodlar }, status: ProductStatus.PUBLISHED },
      select: {
        id: true,
        logoItemCode: true,
        units: {
          where: { isActive: true },
          select: { id: true, code: true, isDefaultForOrder: true, isBaseUnit: true },
        },
      },
    });

    const urunHaritasi = new Map(urunler.map((urun) => [urun.logoItemCode.toUpperCase(), urun]));

    const eklenecek: { productId: string; unitId: string; quantity: number }[] = [];
    const bulunamayanKodlar: string[] = [];

    for (const satir of satirlar) {
      const urun = urunHaritasi.get(satir.stokKodu.toUpperCase());

      if (!urun) {
        bulunamayanKodlar.push(`${satir.satirNo}. satır: ${satir.stokKodu}`);
        continue;
      }

      /* Birim dosyada YOKTUR; siparis birimi (genelde koli) varsayilir.
         Excel'de birim tasimak isteyen kullanici zaten portalden girer -
         burada amac hizdir, tam kontrol degil. */
      const birim =
        urun.units.find((u) => u.isDefaultForOrder) ??
        urun.units.find((u) => u.isBaseUnit) ??
        urun.units[0];

      if (!birim) {
        bulunamayanKodlar.push(`${satir.satirNo}. satır: ${satir.stokKodu} (birim tanımsız)`);
        continue;
      }

      /* Ayni kod birden fazla satirda geciyorsa miktarlar TOPLANIR. Kullanici
         listesini boyle hazirlamis olabilir ve son satiri kazanan bir mantik,
         siparisin bir kismini sessizce dusururdu. */
      const mevcut = eklenecek.find(
        (kalem) => kalem.productId === urun.id && kalem.unitId === birim.id,
      );

      if (mevcut) {
        mevcut.quantity += satir.miktar;
      } else {
        eklenecek.push({ productId: urun.id, unitId: birim.id, quantity: satir.miktar });
      }
    }

    let sepet: CartView;

    if (replaceExisting) {
      sepet = await this.cart.replaceItems(owner, { items: eklenecek });
    } else {
      sepet = await this.cart.getCart(owner);
      for (const kalem of eklenecek) {
        sepet = await this.cart.addItem(owner, kalem);
      }
    }

    return {
      cart: sepet,
      importedCount: eklenecek.length,
      totalLines: satirlar.length + hataliSatirlar.length,
      unmatchedCodes: bulunamayanKodlar.slice(0, 100),
      invalidLines: hataliSatirlar.slice(0, 100),
    };
  }

  private ayristir(content: string): {
    satirlar: AyristirilmisSatir[];
    hataliSatirlar: string[];
  } {
    const satirlar: AyristirilmisSatir[] = [];
    const hataliSatirlar: string[] = [];

    const hamSatirlar = content.split(/\r?\n/).slice(0, AZAMI_SATIR);

    hamSatirlar.forEach((ham, indeks) => {
      const temiz = ham.trim();
      if (temiz.length === 0) return;

      const parcalar = temiz.split(/[;,\t]/).map((parca) => parca.trim());

      if (parcalar.length < 2) {
        hataliSatirlar.push(`${indeks + 1}. satır: ${temiz.slice(0, 60)}`);
        return;
      }

      const stokKodu = (parcalar[0] ?? '').replace(/^["']|["']$/g, '');
      const miktar = this.miktarCoz(parcalar[1] ?? '');

      if (stokKodu.length === 0 || miktar === null || miktar <= 0) {
        /* Baslik satiri burada dusuyor. Ilk satirsa hata listesine EKLENMEZ:
           "Stok Kodu;Adet" yazan bir baslik, kullanicinin hatasi degil
           aliskanligidir. */
        if (indeks > 0) {
          hataliSatirlar.push(`${indeks + 1}. satır: ${temiz.slice(0, 60)}`);
        }
        return;
      }

      satirlar.push({ satirNo: indeks + 1, stokKodu, miktar, ham: temiz });
    });

    return { satirlar, hataliSatirlar };
  }

  /**
   * Miktari cozer. "1,5" ve "1.5" ayni seydir; "1.250" ise bin iki yuz elli.
   *
   * Ayrimi soyle yaparız: son ayractan sonra IKI VEYA DAHA AZ hane varsa o
   * ayrac ondaliktir, aksi halde binliktir. Bu kural Excel ciktilarinda
   * gozlenen bicimlerin tamamini dogru cozer.
   */
  private miktarCoz(ham: string): number | null {
    const temiz = ham.replace(/["'\s]/g, '');
    if (temiz.length === 0) return null;

    const sonNokta = temiz.lastIndexOf('.');
    const sonVirgul = temiz.lastIndexOf(',');
    const sonAyrac = Math.max(sonNokta, sonVirgul);

    let normalize: string;

    if (sonAyrac === -1) {
      normalize = temiz;
    } else {
      const kuyruk = temiz.length - sonAyrac - 1;

      normalize =
        kuyruk <= 2
          ? temiz.slice(0, sonAyrac).replace(/[.,]/g, '') + '.' + temiz.slice(sonAyrac + 1)
          : temiz.replace(/[.,]/g, '');
    }

    const sayi = Number(normalize);
    return Number.isFinite(sayi) ? sayi : null;
  }
}
