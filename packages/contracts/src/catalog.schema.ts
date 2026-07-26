/**
 * ToptanPortal - Katalog Sozlesmeleri
 *
 * KOR SIPARIS NOTU: Asagidaki tiplerde fiyat alanlari OPSIYONELDIR. Sunucu,
 * yetkisi olmayan kullaniciya bu alanlari hic gondermez (silinir, sifirlanmaz).
 * Istemciler alanin varligini kontrol etmeli, degerine guvenmemelidir.
 */

import { z } from 'zod';
import { StockStatus } from './blind-order';

export const productUnitSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  /** 1 bu birim = kaç ana birim (örn. 1 Koli = 36 Adet) */
  conversionFactor: z.number().positive(),
  isBaseUnit: z.boolean(),
  isDefaultForOrder: z.boolean(),
  /** Fiyat görme yetkisi yoksa gelmez. */
  unitPrice: z.number().optional(),
});

export type ProductUnitView = z.infer<typeof productUnitSchema>;

export const catalogProductSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  brand: z.string().nullable(),
  categoryPath: z.string().nullable(),
  imageUrl: z.string().nullable(),
  baseUnitCode: z.string(),
  units: z.array(productUnitSchema),
  stockStatus: z.nativeEnum(StockStatus),
  /**
   * Sayısal serbest stok. Kör Sipariş Modunda GÖNDERİLMEZ — depo kapasitesi
   * rakip istihbaratı değeri taşır.
   */
  freeStock: z.number().optional(),
  minOrderQuantity: z.number(),
  maxOrderQuantity: z.number().nullable(),
  /** Fiyat görme yetkisi yoksa gelmez. */
  vatRate: z.number().optional(),
  /** Varsayılan sipariş biriminin vergi hariç fiyatı. Yetki yoksa gelmez. */
  price: z.number().optional(),
});

export type CatalogProduct = z.infer<typeof catalogProductSchema>;

export const catalogQuerySchema = z.object({
  /** Ürün adı, kodu veya barkodda arama */
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(240).optional(),
  brand: z.string().trim().max(80).optional(),
  /** Yalnızca stokta olanlar */
  inStockOnly: z.coerce.boolean().default(false),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});

export type CatalogQuery = z.infer<typeof catalogQuerySchema>;

export const catalogPageSchema = z.object({
  items: z.array(catalogProductSchema),
  nextCursor: z.string().uuid().nullable(),
  blindOrderMode: z.boolean(),
});

export type CatalogPage = z.infer<typeof catalogPageSchema>;

export const barcodeLookupSchema = z.object({
  barcode: z
    .string()
    .trim()
    .min(4, 'Barkod çok kısa.')
    .max(48)
    .regex(/^[0-9A-Za-z-]+$/, 'Barkod geçersiz karakter içeriyor.'),
});

export type BarcodeLookupRequest = z.infer<typeof barcodeLookupSchema>;
