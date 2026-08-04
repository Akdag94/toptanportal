/**
 * ToptanPortal API - Alan Sahipligi Kurallari (Logo <-> portal)
 *
 * Portal Logo'ya yazmaya basladigi andan itibaren, senkronun her turu bir soru
 * sorar: "elimdeki Logo degeri, portaldekinin ustune yazilmali mi?"
 *
 * Cevap her zaman "evet" olamaz. Portalde yapilmis ama HENUZ Logo'ya
 * ULASMAMIS bir degisiklik varsa, Logo'nun degeri o degisiklikten oncesine
 * aittir - ustune yazmak, kullanicinin biraz once yaptigi degisikligi
 * sessizce geri almaktir. Bu tam olarak, fiyat yazimini uzun sure
 * yapmamamizin gerekcesi olan hataydi; yon degistirdigi icin ortadan
 * kalkmadi, sadece yer degistirdi.
 *
 * Kurallar burada TEK YERDE ve SAF fonksiyon olarak durur: senkron
 * servislerinin icine gomulmus bir kosul, ikinci bir senkron kanali
 * eklendiginde kopyalanir ve kopyalardan biri gunun birinde geride kalir.
 */

import { LogoWriteState } from '@toptanportal/db';

/**
 * Logo'dan gelen deger portaldekinin ustune yazilabilir mi?
 *
 *   * `SYNCED`  -> EVET. Iki taraf esittir; gelen deger ya aynidir ya da
 *                  Logo'da yapilmis gercek bir degisikliktir.
 *   * `PENDING` -> HAYIR. Portalde yapilmis degisiklik kuyrukta bekliyor.
 *                  Ustune yazmak, kullanicinin degisikligini o daha ekrandan
 *                  ayrilmadan geri almaktir - ve kuyruktaki olay bir sure
 *                  sonra ESKI portal degerini degil, geri alinmis degeri
 *                  Logo'ya yazar. Iki taraf da yanlis olur.
 *   * `FAILED`  -> HAYIR. Logo degisikligi reddetti ve iki taraf AYRISMIS
 *                  durumda. Logo'nun degerini yazmak ayrismayi gorunmez
 *                  kilardi: hata isareti temizlenir, operator bakmasi
 *                  gereken satiri hic gormez ve kullanici degisikligin
 *                  yapildigini sanmaya devam eder. Ayrisma, duzeltilene
 *                  kadar GORUNUR kalmalidir.
 */
export function logoDegeriYazilabilir(state: LogoWriteState): boolean {
  return state === LogoWriteState.SYNCED;
}

/**
 * Logo'nun TUTMADIGI, dolayisiyla senkronun asla yazmadigi urun alanlari.
 *
 * Bu liste bir izin listesi degil, bir YASAK listesidir: senkron bu alanlara
 * hicbir kosulda dokunmaz. Logo'dan gelen bir urun guncellemesi bu alanlari
 * bos gonderirdi (cunku Logo'da karsiligi yok) ve bos deger, dolu bir alanin
 * ustune yazildiginda kullanicinin girdigi aciklamayi ve gorseli siler.
 * Silinme sessizdir; aylar sonra, alan yeniden doldurulurken fark edilir.
 */
export const SENKRONUN_DOKUNMADIGI_URUN_ALANLARI = [
  'description',
  'imageUrl',
  'categoryPath',
  'sortOrder',
  'criticalStockThreshold',
  'minOrderQuantity',
  'maxOrderQuantity',
  'status',
  'origin',
  'logoWriteState',
  'logoWriteError',
] as const;

/**
 * Logo'dan gelen bir urun govdesinden, portalin sahip oldugu alanlari ATAR.
 *
 * Suzgec cagiran tarafa birakilmaz: "bu alani yazma" kosulunu her senkron
 * servisinde elle tekrarlamak, bir gun unutulacak bir kosuldur ve unutuldugu
 * turda veri sessizce kaybolur.
 */
export function logoGuncellemesiniSuz<T extends Record<string, unknown>>(
  gelen: T,
): Partial<T> {
  const yasakli = new Set<string>(SENKRONUN_DOKUNMADIGI_URUN_ALANLARI);
  const sonuc: Record<string, unknown> = {};

  for (const [alan, deger] of Object.entries(gelen)) {
    if (!yasakli.has(alan)) sonuc[alan] = deger;
  }

  return sonuc as Partial<T>;
}
