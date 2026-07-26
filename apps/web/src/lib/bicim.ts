/**
 * ToptanPortal Web - Bicimlendirme Yardimcilari
 *
 * KOR SIPARIS KURALI: Bu dosyadaki para bicimlendiricileri `number | undefined`
 * kabul eder ve deger YOKSA null doner - "0,00 TL" DEGIL. Yetkisi olmayan
 * kullaniciya sifir tutar gostermek, gizlenmis bir tutari gizlenmemis gibi
 * sunmaktir; kullanici bunu gercek bir bedel sanabilir.
 *
 * Cagiran taraf null durumunda alani hic render etmemelidir.
 */

const paraBicimleri = new Map<string, Intl.NumberFormat>();

function paraBicimi(kod: string): Intl.NumberFormat {
  let bicim = paraBicimleri.get(kod);

  if (!bicim) {
    bicim = new Intl.NumberFormat('tr-TR', {
      style: 'currency',
      currency: kod,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    paraBicimleri.set(kod, bicim);
  }

  return bicim;
}

/** Tutar yoksa null doner. Sifir ile "gosterilmiyor" birbirine karistirilmaz. */
export function para(tutar: number | undefined, kod = 'TRY'): string | null {
  if (typeof tutar !== 'number' || !Number.isFinite(tutar)) return null;
  return paraBicimi(kod).format(tutar);
}

const miktarBicimi = new Intl.NumberFormat('tr-TR', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 4,
});

export function miktar(deger: number): string {
  return miktarBicimi.format(deger);
}

const tarihBicimi = new Intl.DateTimeFormat('tr-TR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function tarihSaat(isoTarih: string): string {
  return tarihBicimi.format(new Date(isoTarih));
}

const gunBicimi = new Intl.DateTimeFormat('tr-TR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

export function gun(isoTarih: string | null): string {
  return isoTarih ? gunBicimi.format(new Date(isoTarih)) : '—';
}

/** Yuzde orani: 5 -> "%5", 7.5 -> "%7,5" */
export function yuzde(oran: number): string {
  return `%${new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 3 }).format(oran)}`;
}
