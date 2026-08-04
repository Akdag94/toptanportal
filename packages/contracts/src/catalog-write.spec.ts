/**
 * Katalog yazma sozlesmesinin testleri.
 *
 * Buradaki kurallarin ortak yani sudur: hepsi Logo'da KALICI bir kayit dogurur.
 * Yanlis birim seti tanimlanmis bir kart, siparis alindiktan sonra duzeltilemez;
 * yanlis stok kodu, gecmisi baska bir karta baglar. Bu yuzden dogrulama
 * gonderimden ONCE yapilir ve testler o dogrulamayi kilitler.
 */

import { describe, expect, it } from 'vitest';

import {
  LogoWriteState,
  PORTAL_OWNED_PRODUCT_FIELDS,
  ProductOrigin,
  priceChangeSchema,
  productCreateSchema,
  productUpdateSchema,
  writableIdentityFields,
} from './catalog-write.schema';

const gecerliKart = {
  logoItemCode: 'KHV-250',
  name: 'Filtre Kahve 250 g',
  vatRate: 10 as const,
  units: [
    { code: 'ADET', name: 'Adet', conversionFactor: 1, isBaseUnit: true, isDefaultForOrder: false },
    { code: 'KOLI', name: 'Koli', conversionFactor: 12, isBaseUnit: false, isDefaultForOrder: true },
  ],
};

describe('Stok kodu', () => {
  it('küçük harf ve Türkçe karakter reddedilir', () => {
    /* Logo cogu kurulumda kodu buyuk harfe cevirerek saklar; "Çay" ile "CAY"
       ayni kartin iki kopyasini uretir ve stok ikiye bolunur. */
    for (const kod of ['khv-250', 'ÇAY-1', 'kod 1']) {
      expect(productCreateSchema.safeParse({ ...gecerliKart, logoItemCode: kod }).success).toBe(
        false,
      );
    }
  });

  it('büyük harf, rakam ve ayraçlar kabul edilir', () => {
    for (const kod of ['KHV-250', 'SUT_1L', 'AMB.01']) {
      expect(productCreateSchema.safeParse({ ...gecerliKart, logoItemCode: kod }).success).toBe(
        true,
      );
    }
  });

  it('güncellemede stok kodu gönderilemez — gönderilse de yok sayılır', () => {
    const sonuc = productUpdateSchema.safeParse({ logoItemCode: 'BASKA-KOD', name: 'Yeni ad' });

    expect(sonuc.success).toBe(true);
    expect(sonuc.success && 'logoItemCode' in sonuc.data).toBe(false);
  });
});

describe('Birim seti', () => {
  it('ana birim tam olarak bir tanedir', () => {
    const anasiz = productCreateSchema.safeParse({
      ...gecerliKart,
      units: gecerliKart.units.map((birim) => ({ ...birim, isBaseUnit: false })),
    });

    const ikiAna = productCreateSchema.safeParse({
      ...gecerliKart,
      units: gecerliKart.units.map((birim) => ({ ...birim, isBaseUnit: true })),
    });

    expect(anasiz.success).toBe(false);
    expect(ikiAna.success).toBe(false);
  });

  it('ana birimin çevrim katsayısı 1 olmalıdır', () => {
    const sonuc = productCreateSchema.safeParse({
      ...gecerliKart,
      units: [{ ...gecerliKart.units[0]!, conversionFactor: 12 }],
    });

    expect(sonuc.success).toBe(false);
  });

  it('aynı birim kodu iki kez tanımlanamaz', () => {
    const sonuc = productCreateSchema.safeParse({
      ...gecerliKart,
      units: [gecerliKart.units[0]!, { ...gecerliKart.units[1]!, code: 'adet' }],
    });

    expect(sonuc.success).toBe(false);
  });

  it('yalnızca bir birim varsayılan sipariş birimi olabilir', () => {
    const sonuc = productCreateSchema.safeParse({
      ...gecerliKart,
      units: gecerliKart.units.map((birim) => ({ ...birim, isDefaultForOrder: true })),
    });

    expect(sonuc.success).toBe(false);
  });
});

describe('KDV oranı', () => {
  it('yalnızca yürürlükteki oranlar kabul edilir', () => {
    for (const oran of [0, 1, 10, 20]) {
      expect(productCreateSchema.safeParse({ ...gecerliKart, vatRate: oran }).success).toBe(true);
    }
  });

  it('serbest oran reddedilir', () => {
    /* %18 artik yururlukte degil; serbest giris, eski oranla acilmis bir kartin
       faturaya kadar fark edilmemesine yol acar. */
    for (const oran of [8, 18, 5.5]) {
      expect(productCreateSchema.safeParse({ ...gecerliKart, vatRate: oran }).success).toBe(false);
    }
  });
});

describe('Yayına alma', () => {
  it('kart varsayılan olarak yayına açılmaz', () => {
    const sonuc = productCreateSchema.parse(gecerliKart);

    /* Yeni kartin stogu ve fiyati henuz Logo'dan gelmedi. Yayina dogrudan
       acmak, bayiye fiyatsiz ve stoksuz bir urun gostermektir. */
    expect(sonuc.publishImmediately).toBe(false);
  });
});

describe('Sipariş miktarı sınırları', () => {
  it('azami miktar asgariden küçük olamaz', () => {
    const sonuc = productCreateSchema.safeParse({
      ...gecerliKart,
      minOrderQuantity: 10,
      maxOrderQuantity: 5,
    });

    expect(sonuc.success).toBe(false);
  });
});

describe('Alan sahipliği', () => {
  it('Logo kökenli kartta portalden yazılabilecek kimlik alanı yoktur', () => {
    /* Logo'da acilmis bir kartin adini portalden degistirmek, muhasebecinin
       defterinde gordugu adi haberi olmadan degistirmektir. */
    expect(writableIdentityFields(ProductOrigin.LOGO)).toEqual([]);
  });

  it('portal kökenli kartın kimlik alanları portalde düzenlenir', () => {
    expect(writableIdentityFields(ProductOrigin.PORTAL)).toContain('name');
    expect(writableIdentityFields(ProductOrigin.PORTAL)).toContain('vatRate');
  });

  it('sunum alanları kökenden bağımsızdır ve senkron korumasındadır', () => {
    /* Bu liste senkronun ezmeyecegi alanlarin TEK kaynagidir; buraya yazilmayan
       yeni bir sunum alani ilk senkron turunda sessizce bosalir. */
    for (const alan of ['description', 'imageUrl', 'categoryPath', 'sortOrder']) {
      expect(PORTAL_OWNED_PRODUCT_FIELDS).toContain(alan);
    }
  });
});

describe('Fiyat değişikliği', () => {
  const gecerliFiyat = {
    priceListId: '11111111-1111-4111-8111-111111111111',
    productId: '22222222-2222-4222-8222-222222222222',
    price: 149.9,
    reason: 'Tedarikçi zammı',
  };

  it('gerekçe zorunludur', () => {
    /* Alti ay sonra "bana neden bu fiyattan kesildi" sorusu geldiginde eski
       fiyati gormek yetmez; neden degistigi de kayitta olmalidir. */
    expect(priceChangeSchema.safeParse({ ...gecerliFiyat, reason: '' }).success).toBe(false);
    expect(priceChangeSchema.safeParse({ ...gecerliFiyat, reason: 'ok' }).success).toBe(false);
  });

  it('sıfır fiyat kabul edilir, negatif reddedilir', () => {
    /* Sifir promosyon/numune kartidir; negatif birim fiyat siparis toplamini
       eksiye cevirir. */
    expect(priceChangeSchema.safeParse({ ...gecerliFiyat, price: 0 }).success).toBe(true);
    expect(priceChangeSchema.safeParse({ ...gecerliFiyat, price: -1 }).success).toBe(false);
  });

  it('birim verilmezse ana birim fiyatıdır', () => {
    const sonuc = priceChangeSchema.parse(gecerliFiyat);

    expect(sonuc.unitId ?? null).toBeNull();
    expect(sonuc.minQuantity).toBe(0);
  });
});

describe('Logo yazma durumu', () => {
  it('üç durum tanımlıdır ve hiçbiri "bilinmiyor" değildir', () => {
    /* Belirsiz bir dorduncu durum, ekranda "belki gitti" demek olurdu; operator
       o durumda ne yapacagini bilemez. Her kayit ya esittir, ya kuyruktadir,
       ya da reddedilmistir. */
    expect(Object.values(LogoWriteState)).toEqual(['SYNCED', 'PENDING', 'FAILED']);
  });
});
