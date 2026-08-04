/**
 * Alan sahipligi kurallarinin testleri.
 *
 * Bu dosya, cift yonlu yazimin en sessiz hata bicimini kilitler: senkronun,
 * portalde biraz once yapilmis bir degisikligin ustune yazmasi. Hata gorunur
 * bir istisna uretmez - kullanici degisikligi yapar, ekranda gorur, birkac
 * dakika sonra deger eski haline doner ve neden dondugunu kimse aciklayamaz.
 */

import { LogoWriteState } from '@toptanportal/db';

import {
  SENKRONUN_DOKUNMADIGI_URUN_ALANLARI,
  logoDegeriYazilabilir,
  logoGuncellemesiniSuz,
} from './catalog-ownership';

describe('Logo değeri portaldekinin üstüne yazılabilir mi', () => {
  it('SYNCED durumunda yazılır — iki taraf eşittir', () => {
    expect(logoDegeriYazilabilir(LogoWriteState.SYNCED)).toBe(true);
  });

  it('PENDING durumunda YAZILMAZ — kuyrukta bekleyen değişiklik geri alınırdı', () => {
    /* Ustune yazilsaydi kullanicinin degisikligi o daha ekrandan ayrilmadan
       geri alinir; sonra kuyruktaki olay, geri alinmis degeri Logo'ya yazar
       ve iki taraf da yanlis olur. */
    expect(logoDegeriYazilabilir(LogoWriteState.PENDING)).toBe(false);
  });

  it('FAILED durumunda YAZILMAZ — ayrışma görünür kalmalıdır', () => {
    /* Logo'nun degerini yazmak, hata isaretini de temizler: operator bakmasi
       gereken satiri hic gormez, kullanici degisikligin yapildigini sanmaya
       devam eder. */
    expect(logoDegeriYazilabilir(LogoWriteState.FAILED)).toBe(false);
  });

  it('yalnızca tek bir durum yazmaya izin verir', () => {
    const izinli = Object.values(LogoWriteState).filter(logoDegeriYazilabilir);

    expect(izinli).toEqual([LogoWriteState.SYNCED]);
  });
});

describe('Senkronun dokunmadığı ürün alanları', () => {
  it('sunum alanları Logo güncellemesinden düşürülür', () => {
    /* Logo bu alanlari tutmaz; gelen govdede bos gelirler ve bos deger, dolu
       bir alanin ustune yazildiginda kullanicinin girdigi aciklamayi siler.
       Silinme sessizdir, aylar sonra fark edilir. */
    const suzulmus = logoGuncellemesiniSuz({
      name: 'Filtre Kahve 250 g',
      description: '',
      imageUrl: '',
      categoryPath: '',
      vatRate: 10,
    });

    expect(suzulmus).toEqual({ name: 'Filtre Kahve 250 g', vatRate: 10 });
  });

  it('köken ve yazma durumu senkron tarafından değiştirilemez', () => {
    /* Koken degisirse sahiplik kurali her guncellemede yeniden tanimlanir ve
       kural olmaktan cikar; yazma durumunu senkronun degistirmesi ise
       operatorun bakmasi gereken hatayi silerdi. */
    const suzulmus = logoGuncellemesiniSuz({
      origin: 'LOGO',
      logoWriteState: 'SYNCED',
      logoWriteError: null,
      brand: 'Marka',
    });

    expect(suzulmus).toEqual({ brand: 'Marka' });
  });

  it('yasak listesi sunum alanlarının tamamını kapsar', () => {
    for (const alan of ['description', 'imageUrl', 'categoryPath', 'sortOrder', 'status']) {
      expect(SENKRONUN_DOKUNMADIGI_URUN_ALANLARI).toContain(alan);
    }
  });

  it('boş gövde boş kalır — süzgeç alan uydurmaz', () => {
    expect(logoGuncellemesiniSuz({})).toEqual({});
  });
});
