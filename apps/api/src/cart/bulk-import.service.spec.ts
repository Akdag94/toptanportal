/**
 * Toplu ice aktarim ayristirici testleri.
 *
 * Buradaki her durum GERCEK bir Excel dosyasindan gelir. Miktar ayristirmasi
 * ozellikle onemlidir: "1.250" satirini bir virgul iki yuz elli okumak,
 * bin iki yuz elli koli yerine bir koli siparis etmek demektir - ve bunu
 * kimse dosyayi yuklerken fark etmez.
 */

import type { PrismaService } from '../common/prisma/prisma.service';
import type { CartService } from './cart.service';
import { BulkImportService } from './bulk-import.service';

function build(): BulkImportService {
  return new BulkImportService({} as PrismaService, {} as CartService);
}

/** `private` yontemlere testten erisim - ayristirma saf bir fonksiyondur. */
function ayristir(icerik: string) {
  return (
    build() as unknown as {
      ayristir: (icerik: string) => {
        satirlar: { satirNo: number; stokKodu: string; miktar: number }[];
        hataliSatirlar: string[];
      };
    }
  ).ayristir(icerik);
}

function miktar(ham: string): number | null {
  return (build() as unknown as { miktarCoz: (ham: string) => number | null }).miktarCoz(ham);
}

describe('miktar çözümleme', () => {
  it('ondalık ayracı olarak virgülü de noktayı da kabul eder', () => {
    expect(miktar('1,5')).toBe(1.5);
    expect(miktar('1.5')).toBe(1.5);
  });

  it('binlik ayracını ondalık sanmaz', () => {
    // "1.250" bin iki yuz ellidir; 1,25 okumak siparisi 1000 kat kucultur.
    expect(miktar('1.250')).toBe(1250);
    expect(miktar('12.500')).toBe(12500);
  });

  it('binlik ve ondalık birlikte geldiğinde doğru çözer', () => {
    expect(miktar('1.250,75')).toBe(1250.75);
    expect(miktar('1,250.75')).toBe(1250.75);
  });

  it('tam sayıyı olduğu gibi okur', () => {
    expect(miktar('24')).toBe(24);
  });

  it('sayı olmayanı reddeder', () => {
    expect(miktar('adet')).toBeNull();
    expect(miktar('')).toBeNull();
  });
});

describe('satır ayrıştırma', () => {
  it('noktalı virgül, virgül ve sekme ayracını destekler', () => {
    const { satirlar } = ayristir('URUN1;5\nURUN2,3\nURUN3\t7');

    expect(satirlar.map((satir) => satir.stokKodu)).toEqual(['URUN1', 'URUN2', 'URUN3']);
    expect(satirlar.map((satir) => satir.miktar)).toEqual([5, 3, 7]);
  });

  it('başlık satırını sessizce atlar — hata olarak göstermez', () => {
    const { satirlar, hataliSatirlar } = ayristir('Stok Kodu;Adet\nURUN1;5');

    expect(satirlar).toHaveLength(1);
    expect(hataliSatirlar).toHaveLength(0);
  });

  it('okunamayan satırı hata listesine koyar — sessizce atmaz', () => {
    const { satirlar, hataliSatirlar } = ayristir('URUN1;5\nBOZUK SATIR\nURUN2;3');

    expect(satirlar).toHaveLength(2);
    expect(hataliSatirlar).toHaveLength(1);
    expect(hataliSatirlar[0]).toContain('2. satır');
  });

  it('sıfır ve negatif miktarı reddeder', () => {
    const { satirlar, hataliSatirlar } = ayristir('URUN1;5\nURUN2;0\nURUN3;-4');

    expect(satirlar).toHaveLength(1);
    expect(hataliSatirlar).toHaveLength(2);
  });

  it('boş satırları yok sayar', () => {
    const { satirlar, hataliSatirlar } = ayristir('URUN1;5\n\n\nURUN2;3\n');

    expect(satirlar).toHaveLength(2);
    expect(hataliSatirlar).toHaveLength(0);
  });

  it('tırnak içindeki kodu temizler', () => {
    const { satirlar } = ayristir('"URUN1";5');
    expect(satirlar[0]?.stokKodu).toBe('URUN1');
  });

  it('satır numarasını korur — kullanıcı dosyada o satırı bulacak', () => {
    const { satirlar } = ayristir('Stok;Adet\nURUN1;5\nURUN2;3');

    expect(satirlar[0]?.satirNo).toBe(2);
    expect(satirlar[1]?.satirNo).toBe(3);
  });
});
