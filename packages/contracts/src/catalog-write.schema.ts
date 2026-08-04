/**
 * ToptanPortal - Katalog Yazma Sozlesmeleri (portal -> Logo)
 *
 * Portal artik yalnizca Logo'yu OKUMAZ; urun karti acar ve fiyat degistirir.
 * Bu, iki sistemin ayni alani yazabildigi her yerde sorulan soruyu dogurur:
 * "cakistiklarinda hangisi dogru?"
 *
 * Cevap tek bir bayrakla verilemez, cunku bir urun kartinin farkli alanlarinin
 * dogal sahibi farklidir. Bu dosyanin asil isi o sahipligi YAZILI hale
 * getirmektir:
 *
 *   * SUNUM alanlari (aciklama, gorsel, kategori, siralama, kritik esik,
 *     asgari/azami siparis miktari) her zaman PORTALINDIR. Logo bu alanlari
 *     zaten tutmaz; senkron onlara dokunmaz.
 *
 *   * KIMLIK alanlari (ad, birim seti, KDV orani) kartin KOKENINE gore
 *     sahiplenilir. Portalde acilmis kart portalde duzenlenir; Logo'da acilmis
 *     kartin adini portalden degistirmek, muhasebecinin defterinde gordugu adi
 *     haberi olmadan degistirmektir.
 *
 *   * MUHASEBE ve STOK alanlari (fiili stok, cari bakiye, muhasebe kodu) HER
 *     ZAMAN Logo'nundur. Portal bunlari hicbir kosulda yazmaz.
 *
 * Fiyat bu ayrimin disindadir ve bilincli olarak tek yonlu birakilmistir:
 * portalden degistirilen fiyat Logo'ya YAZILIR, oradan geri okunur. Fiyati
 * yalnizca portalde tutmak, faturayi kesen sistemin baska bir fiyat bilmesi
 * demektir - ve fatura, portalin ekraninda yazani degil Logo'nun bildigini
 * tasir.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Koken ve yazma durumu
// ---------------------------------------------------------------------------

/**
 * Kartin nerede DOGDUGU. Nerede duzenlenebilecegini bu belirler.
 *
 * Koken, "en son kim yazdi" bilgisinden ayridir ve DEGISMEZ: Logo'da acilmis
 * bir kart portalden guncellendi diye portalin mali olmaz. Degisebilir bir
 * koken, sahiplik kuralini her guncellemede yeniden tanimlar ve kural olmaktan
 * cikar.
 */
export const ProductOrigin = {
  LOGO: 'LOGO',
  PORTAL: 'PORTAL',
} as const;

export type ProductOrigin = (typeof ProductOrigin)[keyof typeof ProductOrigin];

export const PRODUCT_ORIGIN_LABELS: Record<ProductOrigin, string> = {
  LOGO: 'Logo’da açıldı',
  PORTAL: 'Portalde açıldı',
};

/**
 * Portalde yapilan degisikligin Logo'ya ULASIP ULASMADIGI.
 *
 * Bu alan olmadan ekran yalan soyler: kullanici fiyati degistirir, ekranda yeni
 * fiyati gorur ve isinin bittigini sanir - Logo'ya yazim ise kuyrukta beklemekte
 * ya da basarisiz olmus olabilir. Fiyat farkinin fatura kesildikten sonra fark
 * edilmesi, bu alanin bulunmamasinin bedelidir.
 */
export const LogoWriteState = {
  /** Portalde degisiklik yok ya da Logo ile ayni. */
  SYNCED: 'SYNCED',
  /** Kuyrukta; henuz yazilmadi. */
  PENDING: 'PENDING',
  /** Logo reddetti; operator mudahalesi bekliyor. */
  FAILED: 'FAILED',
} as const;

export type LogoWriteState = (typeof LogoWriteState)[keyof typeof LogoWriteState];

export const LOGO_WRITE_STATE_LABELS: Record<LogoWriteState, string> = {
  SYNCED: 'Logo ile eşit',
  PENDING: 'Logo’ya yazılıyor',
  FAILED: 'Logo reddetti',
};

/**
 * Logo'nun tutmadigi, dolayisiyla senkronun ASLA ezmedigi alanlar.
 *
 * Liste hem API hem senkron tarafindan okunur. Tek listede tutulmasinin sebebi
 * su: yeni bir sunum alani eklendiginde (ornegin "vitrin etiketi") onu senkron
 * korumasina yazmayi unutmak, alanin ilk senkron turunda sessizce bosalmasi
 * demektir - ve kullanici bunu ancak aylar sonra, alani tekrar doldururken fark
 * eder.
 */
export const PORTAL_OWNED_PRODUCT_FIELDS = [
  'description',
  'imageUrl',
  'categoryPath',
  'sortOrder',
  'criticalStockThreshold',
  'minOrderQuantity',
  'maxOrderQuantity',
  'status',
] as const;

export type PortalOwnedProductField = (typeof PORTAL_OWNED_PRODUCT_FIELDS)[number];

/**
 * Kokene gore, portalin Logo'ya YAZABILECEGI kimlik alanlari.
 *
 * Logo kokenli kartta bos donmesi kasitlidir: o kartin adini ve birimini
 * degistirme yetkisi portalde yoktur, dolayisiyla Logo'ya gonderilecek bir
 * kimlik alani da yoktur.
 */
export function writableIdentityFields(origin: ProductOrigin): readonly string[] {
  return origin === ProductOrigin.PORTAL
    ? (['name', 'brand', 'vatRate', 'units'] as const)
    : ([] as const);
}

// ---------------------------------------------------------------------------
// Urun olusturma
// ---------------------------------------------------------------------------

/**
 * Stok kodu Logo'nun BIRINCIL ANAHTARIDIR ve sonradan degistirilemez.
 *
 * Bosluk ve Turkce karakter reddedilir: Logo tarafinda kod alani cogu kurulumda
 * buyuk harfe cevrilerek saklanir ve "Çay" ile "CAY" iki ayri kart uretir.
 * Ikisi ayni urunu gosterdiginde stok iki karta bolunur ve hicbir rapor toplami
 * dogru vermez.
 */
const logoItemCodeSchema = z
  .string()
  .trim()
  .min(2, 'Stok kodu en az 2 karakter olmalıdır.')
  .max(48, 'Stok kodu en fazla 48 karakter olabilir.')
  .regex(
    /^[A-Z0-9][A-Z0-9._-]*$/,
    'Stok kodu yalnızca büyük harf, rakam, nokta, tire ve alt çizgi içerebilir.',
  );

/**
 * Birim tanimi. Ana birim TAM OLARAK BIR tanedir ve cevrim katsayisi 1'dir.
 *
 * Cevrim katsayisi ana birim cinsindendir (1 Koli = 12 Adet ise Koli icin 12).
 * Katsayiyi ters yonde tanimlamak (0.0833) matematiksel olarak esdegerdir ama
 * kullanicinin kafasindaki sayi 12'dir; ters cevrim, veri girisi hatasini
 * gorunmez kilar.
 */
export const productUnitInputSchema = z.object({
  code: z.string().trim().min(1).max(24),
  name: z.string().trim().min(1).max(48),
  conversionFactor: z.number().positive('Çevrim katsayısı sıfırdan büyük olmalıdır.'),
  isBaseUnit: z.boolean().default(false),
  isDefaultForOrder: z.boolean().default(false),
});

export type ProductUnitInput = z.infer<typeof productUnitInputSchema>;

const unitSetRefinement = (
  units: ProductUnitInput[],
  ctx: z.RefinementCtx,
): void => {
  const anaBirimler = units.filter((birim) => birim.isBaseUnit);

  if (anaBirimler.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['units'],
      message: 'Tam olarak bir ana birim seçilmelidir.',
    });
  }

  if (anaBirimler.length === 1 && anaBirimler[0]!.conversionFactor !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['units'],
      message: 'Ana birimin çevrim katsayısı 1 olmalıdır.',
    });
  }

  const kodlar = units.map((birim) => birim.code.toUpperCase());

  if (new Set(kodlar).size !== kodlar.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['units'],
      message: 'Aynı birim kodu iki kez tanımlanamaz.',
    });
  }

  if (units.filter((birim) => birim.isDefaultForOrder).length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['units'],
      message: 'Yalnızca bir birim varsayılan sipariş birimi olabilir.',
    });
  }
};

export const productCreateSchema = z
  .object({
    logoItemCode: logoItemCodeSchema,
    name: z.string().trim().min(2).max(240),
    description: z.string().trim().max(2000).nullish(),
    brand: z.string().trim().max(80).nullish(),
    categoryPath: z.string().trim().max(240).nullish(),
    imageUrl: z.string().trim().url('Görsel adresi geçerli bir URL olmalıdır.').max(500).nullish(),
    /* KDV orani serbest sayi degildir: Turkiye'de gecerli oranlar sinirlidir ve
       serbest giris, %1 yerine %10 yazilan bir kartin faturaya kadar fark
       edilmemesine yol acar. */
    vatRate: z.union([z.literal(0), z.literal(1), z.literal(10), z.literal(20)]),
    units: z.array(productUnitInputSchema).min(1).max(6),
    criticalStockThreshold: z.number().nonnegative().default(0),
    minOrderQuantity: z.number().nonnegative().default(0),
    maxOrderQuantity: z.number().positive().nullish(),
    sortOrder: z.number().int().min(0).max(99999).default(0),
    /**
     * Kart TASLAK dogar ve varsayilan budur.
     *
     * Yeni acilan bir urun once Logo'ya yazilmali, stogu ve fiyati gelmelidir;
     * yayina dogrudan acmak, bayiye fiyatsiz ve stoksuz bir urun gostermektir -
     * siparis edilir, karsilanamaz.
     */
    publishImmediately: z.boolean().default(false),
  })
  .superRefine((deger, ctx) => {
    unitSetRefinement(deger.units, ctx);

    if (
      deger.maxOrderQuantity !== null &&
      deger.maxOrderQuantity !== undefined &&
      deger.maxOrderQuantity < deger.minOrderQuantity
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxOrderQuantity'],
        message: 'Azami sipariş miktarı, asgari miktardan küçük olamaz.',
      });
    }
  });

export type ProductCreateRequest = z.infer<typeof productCreateSchema>;

// ---------------------------------------------------------------------------
// Urun guncelleme
// ---------------------------------------------------------------------------

/**
 * Guncellemede `logoItemCode` YOKTUR - kod degismez.
 *
 * Kodu degistirmek, Logo'da yeni bir kart acmak ve eskisini sahipsiz birakmakla
 * ayni seydir: eski koda bagli tum hareket, fatura ve siparis gecmisi oldugu
 * yerde kalir, portal ise baska bir karti gosterir. Kod yanlis girildiyse kart
 * kapatilir ve yenisi acilir; bu, geri alinamayan bir islemin dogru yoludur.
 *
 * Kimlik alanlari (`name`, `brand`, `vatRate`) yalnizca PORTAL kokenli kartta
 * kabul edilir; sunucu bunu ayrica denetler - semanin izin vermesi, is kuralinin
 * izin verdigi anlamina gelmez.
 */
export const productUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(240).optional(),
    description: z.string().trim().max(2000).nullish(),
    brand: z.string().trim().max(80).nullish(),
    categoryPath: z.string().trim().max(240).nullish(),
    imageUrl: z.string().trim().url('Görsel adresi geçerli bir URL olmalıdır.').max(500).nullish(),
    vatRate: z.union([z.literal(0), z.literal(1), z.literal(10), z.literal(20)]).optional(),
    criticalStockThreshold: z.number().nonnegative().optional(),
    minOrderQuantity: z.number().nonnegative().optional(),
    maxOrderQuantity: z.number().positive().nullish(),
    sortOrder: z.number().int().min(0).max(99999).optional(),
    /** `ACTIVE` yayinda, `DRAFT` katalogda gorunmez, `ARCHIVED` siparis alamaz. */
    status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
  })
  .refine((deger) => Object.keys(deger).length > 0, {
    message: 'Değiştirilecek en az bir alan gönderilmelidir.',
  });

export type ProductUpdateRequest = z.infer<typeof productUpdateSchema>;

// ---------------------------------------------------------------------------
// Fiyat degistirme
// ---------------------------------------------------------------------------

/**
 * Fiyat degisikligi. Tek satir, tek fiyat - toplu fiyat guncelleme bilincli
 * olarak YOKTUR.
 *
 * Bir ekrandan yuzlerce fiyati birden degistirmek, yanlis bir yuzdeyi tum
 * katalogda uygulama ihtimalini bir tiklik hale getirir ve geri alinmasi
 * Logo'da elle duzeltme gerektirir. Toplu degisiklik gerektiginde dogru arac
 * Logo'nun kendi toplu guncelleme ekranidir; oradan yapilan degisiklik zaten
 * senkronla portale gelir.
 */
export const priceChangeSchema = z.object({
  priceListId: z.string().uuid(),
  productId: z.string().uuid(),
  /** Null ise ana birim fiyatidir. */
  unitId: z.string().uuid().nullish(),
  /** Bu fiyatin gecerli oldugu asgari miktar (kademeli fiyat). */
  minQuantity: z.number().nonnegative().default(0),
  /**
   * Vergi haric birim fiyat. Sifir KABUL EDILIR (promosyon/numune karti),
   * negatif reddedilir - negatif birim fiyat siparis toplamini eksiye cevirir.
   */
  price: z.number().nonnegative('Fiyat negatif olamaz.').max(9_999_999),
  validFrom: z.string().datetime().nullish(),
  validTo: z.string().datetime().nullish(),
  /**
   * Degisiklik gerekcesi. ZORUNLUDUR.
   *
   * Fiyat degisikligi denetim kaydina yazilir ve o kaydin degeri, "neden"
   * sorusunun cevabini tasimasidir: alti ay sonra bir bayi "bana neden bu
   * fiyattan kesildi" diye sordugunda, eski fiyati gormek yetmez.
   */
  reason: z.string().trim().min(3, 'Değişiklik gerekçesi yazılmalıdır.').max(300),
});

export type PriceChangeRequest = z.infer<typeof priceChangeSchema>;

// ---------------------------------------------------------------------------
// Yonetim gorunumleri
// ---------------------------------------------------------------------------

export const adminProductViewSchema = z.object({
  id: z.string().uuid(),
  logoItemCode: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  brand: z.string().nullable(),
  categoryPath: z.string().nullable(),
  imageUrl: z.string().nullable(),
  vatRate: z.number(),
  baseUnitCode: z.string(),
  units: z.array(
    z.object({
      id: z.string().uuid(),
      code: z.string(),
      name: z.string(),
      conversionFactor: z.number(),
      isBaseUnit: z.boolean(),
      isDefaultForOrder: z.boolean(),
    }),
  ),
  criticalStockThreshold: z.number(),
  minOrderQuantity: z.number(),
  maxOrderQuantity: z.number().nullable(),
  sortOrder: z.number().int(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']),
  origin: z.nativeEnum(ProductOrigin),
  logoWriteState: z.nativeEnum(LogoWriteState),
  logoWriteError: z.string().nullable(),
  /** Kokene gore portalden degistirilebilen kimlik alanlari. */
  editableIdentityFields: z.array(z.string()),
  lastSyncedAt: z.string().nullable(),
  updatedAt: z.string(),
});

export type AdminProductView = z.infer<typeof adminProductViewSchema>;

export const adminProductQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  origin: z.nativeEnum(ProductOrigin).optional(),
  /** Yalnizca Logo'ya yazilamamis kartlar - operatorun ilk baktigi liste. */
  writeState: z.nativeEnum(LogoWriteState).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type AdminProductQuery = z.infer<typeof adminProductQuerySchema>;

export const adminProductPageSchema = z.object({
  items: z.array(adminProductViewSchema),
  totalCount: z.number().int(),
  hasMore: z.boolean(),
});

export type AdminProductPage = z.infer<typeof adminProductPageSchema>;
