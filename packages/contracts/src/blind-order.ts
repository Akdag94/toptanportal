/**
 * ToptanPortal - Kor Siparis Modu (Blind Order) Alan Sozlugu
 *
 * GDD Bolum 2 - Kritik Guvenlik Modulu:
 * "Isletme Alt Yetkilisi hesabi ile giris yapildiginda UI layer ve API
 *  yanitlarindaki tum price, discount, balance, tax nesneleri middleware
 *  tarafindan sifirlanir/gizlenir."
 *
 * Bu dosya, hem API interceptor'unun hem de istemcilerin (Web/iOS) ayni alan
 * listesini kullanmasini garanti eder. Alan adi eklerken DAIMA buraya eklenir.
 *
 * Karar: alanlar "0" veya "***" ile maskelenmez, tamamen SILINIR. Maskeleme,
 * alanin varligini ve dolayisiyla veri modelini sizdirir; ayrica istemci
 * tarafinda yanlislikla render edilme riski dogurur.
 */

/**
 * Yanit govdesinden silinecek alan adlari (camelCase, karsilastirma
 * buyuk/kucuk harf duyarsiz yapilir).
 */
export const BLIND_ORDER_STRIPPED_FIELDS: readonly string[] = [
  // Fiyat
  'price',
  'prices',
  'unitPrice',
  'listPrice',
  'basePrice',
  'netPrice',
  'grossPrice',
  'salesPrice',
  'purchasePrice',
  'campaignPrice',
  'specialPrice',
  'priceListId',
  'priceListCode',
  'priceListName',
  'currency',
  'currencyCode',
  'exchangeRate',

  // Iskonto
  'discount',
  'discounts',
  'discountRate',
  'discountRates',
  'discountAmount',
  'lineDiscount',
  'lineDiscounts',
  'footerDiscount',
  'volumeDiscount',
  'tierDiscounts',
  'campaignDiscount',

  // Vergi
  'tax',
  'taxes',
  'taxRate',
  'taxAmount',
  'vat',
  'vatRate',
  'vatAmount',
  'withholdingRate',
  'withholdingAmount',

  // Tutar / toplam
  'amount',
  'totalAmount',
  'total',
  'subTotal',
  'subtotal',
  'grandTotal',
  'lineTotal',
  'netTotal',
  'grossTotal',
  'shippingCost',
  'paidAmount',
  'remainingAmount',

  // Cari / risk
  'balance',
  'currentBalance',
  'openBalance',
  'debit',
  'credit',
  'debitTotal',
  'creditTotal',
  'creditLimit',
  'availableCredit',
  'usedCredit',
  'riskLimit',
  'riskUsage',
  'overdueAmount',
  'overdueDays',
  'agingBuckets',
  'paymentTermDays',
  'dueDate',

  // Evrak
  'invoiceUrl',
  'invoicePdfUrl',
  'invoiceNumber',
  'invoiceTotal',
  'einvoiceUuid',
  'statementUrl',
  'reconciliationUrl',

  // Maliyet / marj (dahili)
  'cost',
  'unitCost',
  'margin',
  'marginRate',
  'profit',
];

const STRIPPED_FIELD_SET: ReadonlySet<string> = new Set(
  BLIND_ORDER_STRIPPED_FIELDS.map((f) => f.toLowerCase()),
);

export function isBlindOrderStrippedField(fieldName: string): boolean {
  return STRIPPED_FIELD_SET.has(fieldName.toLowerCase());
}

/**
 * Kor modda kullaniciya gosterilebilecek stok durumu.
 * Sayisal stok miktari da gizlenir; barista "kac adet var" bilgisini gormez,
 * cunku bu bilgi toptancinin depo kapasitesini rakiplere sizdirabilir.
 * Sadece nitel durum gosterilir.
 */
export const StockStatus = {
  IN_STOCK: 'IN_STOCK',
  CRITICAL: 'CRITICAL',
  OUT_OF_STOCK: 'OUT_OF_STOCK',
} as const;

export type StockStatus = (typeof StockStatus)[keyof typeof StockStatus];

export const STOCK_STATUS_LABELS: Record<StockStatus, string> = {
  [StockStatus.IN_STOCK]: 'Stokta Var',
  [StockStatus.CRITICAL]: 'Kritik Stok',
  [StockStatus.OUT_OF_STOCK]: 'Tükendi',
};

/**
 * Sayisal serbest stogu nitel duruma cevirir.
 * @param freeStock Serbest stok = gercek stok - bekleyen rezervasyonlar
 * @param criticalThreshold Urun kartinda tanimli kritik stok esigi
 */
export function toStockStatus(freeStock: number, criticalThreshold: number): StockStatus {
  if (freeStock <= 0) return StockStatus.OUT_OF_STOCK;
  if (freeStock <= criticalThreshold) return StockStatus.CRITICAL;
  return StockStatus.IN_STOCK;
}
