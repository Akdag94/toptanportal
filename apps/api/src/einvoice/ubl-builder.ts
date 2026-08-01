/**
 * ToptanPortal API - UBL-TR 1.2 Belge Uretimi
 *
 * URETILEN XML HUKUKI ASILDIR. PDF ondan turetilmis bir goruntudur; ihtilafta
 * mahkemeye bu dosya sunulur. Bu yuzden uretim SAF bir islevdir: veritabani,
 * saat veya istek baglami okumaz, ayni girdi ayni bayti uretir. Uretilemeyen
 * bir belge, yanlis uretilmis bir belgeden iyidir - bu dosya sik ISTISNA ATAR.
 *
 * ARITMETIK BELGENIN ICINDE TUTARLI OLMALIDIR. GIB dogrulamasi tutarlari
 * birbirine baglar: satir toplamlari, KDV matrahlari ve belge toplami
 * birbirini tutmazsa belge reddedilir. Bu yuzden belge toplamlari veritabanindaki
 * tutarlardan KOPYALANMAZ, YUVARLANMIS SATIRLARDAN HESAPLANIR; sonuc portalin
 * bildigi toplamla bir kurustan fazla ayrilirsa belge hic uretilmez. Iki farkli
 * toplam tasiyan bir fatura, muhasebede saatlerce aranan bir farktir.
 *
 * KDV MATRAHLARI ORANA GORE GRUPLANIR. Tek bir toplam KDV satiri, farkli
 * oranlardan olusan bir faturada hangi matrahin hangi oranla vergilendigini
 * gizler; GIB bunu kabul etmez ve etmese de mali musavir icin okunamaz olur.
 */

import { EDocumentKind, type EDocumentKind as Kind } from '@toptanportal/contracts';

/** Belge toplaminda kabul edilen azami sapma: yarim kurus. */
const TOLERANCE = 0.005;

/**
 * Portal birim kodu -> UN/ECE Rec 20 birim kodu.
 *
 * YANLIS BIRIM KODU, MIKTARI DEGISTIRIR: koli yerine adet yazan bir fatura,
 * on iki kat farkli bir teslimati belgeler. Taninmayan birim icin uretim
 * durdurulmaz (fatura kesilemez hale gelmesi daha buyuk bir zarardir) ancak
 * UYARI DONULUR ve cagiran taraf bunu gunluge yazar.
 */
const UNIT_CODE_MAP: Record<string, string> = {
  ADET: 'C62',
  AD: 'C62',
  PAKET: 'PK',
  PK: 'PK',
  KOLI: 'BX',
  KUTU: 'BX',
  KASA: 'CS',
  KG: 'KGM',
  GRAM: 'GRM',
  GR: 'GRM',
  TON: 'TNE',
  LITRE: 'LTR',
  LT: 'LTR',
  ML: 'MLT',
  METRE: 'MTR',
  MT: 'MTR',
  M2: 'MTK',
  M3: 'MTQ',
  CIFT: 'PR',
  DUZINE: 'DZN',
};

export interface UblParty {
  /** VKN (10 hane) veya TCKN (11 hane). */
  taxNumber: string;
  title: string;
  taxOffice?: string | null;
  address?: string | null;
  district?: string | null;
  city?: string | null;
  country?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface UblLine {
  lineNumber: number;
  productCode: string;
  productName: string;
  /** Portal birim kodu (ADET, KOLI, KG...). UN/ECE koduna cevrilir. */
  unitCode: string;
  quantity: number;
  unitPrice: number;
  /** Iskonto oncesi satir tutari. */
  grossAmount: number;
  discountTotal: number;
  /** Iskonto sonrasi, KDV haric satir tutari. */
  netAmount: number;
  vatRate: number;
  vatAmount: number;
  note?: string | null;
}

export interface UblDocumentInput {
  kind: Kind;
  /** GIB belge numarasi: 3 harf + 13 hane. */
  documentNumber: string;
  /** ETTN. */
  uuid: string;
  issuedAt: Date;
  currency: string;
  supplier: UblParty;
  customer: UblParty;
  lines: readonly UblLine[];
  orderNumber?: string | null;
  orderDate?: Date | null;
  /** e-Irsaliyede fiili sevk zamani. */
  despatchAt?: Date | null;
  note?: string | null;
  /**
   * Portalin bildigi belge toplami. Satirlardan hesaplanan toplamla
   * karsilastirilir; ayrilirlarsa belge URETILMEZ.
   */
  expectedGrandTotal?: number | null;
}

export interface UblTotals {
  lineExtensionAmount: number;
  taxExclusiveAmount: number;
  taxAmount: number;
  taxInclusiveAmount: number;
  allowanceTotalAmount: number;
}

export interface UblBuildResult {
  xml: string;
  totals: UblTotals;
  /** Belgeyi gecersiz kilmayan ama insanin gormesi gereken durumlar. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Bicimleme
// ---------------------------------------------------------------------------

/**
 * XML kacisi.
 *
 * "A&B Gıda" gibi bir unvan, kacissiz yazildiginda gecersiz XML uretir ve
 * belge entegratorde reddedilir. Tirnak ve apostrof da kacilir: bu metinler
 * oznitelik degeri olarak da kullanilabilir.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Iki ondalikli, nokta ayracli tutar. GIB ondalik ayraci olarak virgul kabul etmez. */
export function formatAmount(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

/** Miktar dort ondalige kadar yazilir; gereksiz sifirlar atilir. */
export function formatQuantity(value: number): string {
  const yuvarlanmis = Math.round(value * 10000) / 10000;
  return String(yuvarlanmis);
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatTime(date: Date): string {
  return date.toISOString().slice(11, 19);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function unitCodeFor(portalUnit: string): { code: string; known: boolean } {
  const anahtar = portalUnit.trim().toLocaleUpperCase('tr-TR');
  const kod = UNIT_CODE_MAP[anahtar];

  return kod ? { code: kod, known: true } : { code: 'C62', known: false };
}

/**
 * Fatura profili.
 *
 * e-Fatura icin TICARIFATURA secilir: alicinin KABUL/RET hakki vardir ve
 * portal bu ayrimi zaten tasir (bkz. EDocumentStatus). TEMELFATURA secmek,
 * alicinin itiraz hakkini belgenin kendisinden silmek olurdu.
 */
function profileId(kind: Kind): string {
  switch (kind) {
    case EDocumentKind.EINVOICE:
      return 'TICARIFATURA';
    case EDocumentKind.EARCHIVE:
      return 'EARSIVFATURA';
    case EDocumentKind.EDESPATCH:
      return 'TEMELIRSALIYE';
    default:
      return 'TEMELFATURA';
  }
}

/** VKN 10, TCKN 11 hanedir; sema tanimlayicisi bu uzunluktan cikar. */
function schemeIdFor(taxNumber: string): string {
  return taxNumber.trim().length === 11 ? 'TCKN' : 'VKN';
}

// ---------------------------------------------------------------------------
// Parcalar
// ---------------------------------------------------------------------------

function partyXml(party: UblParty, girinti: string): string {
  const satirlar: string[] = [
    '<cac:PartyIdentification>',
    `  <cbc:ID schemeID="${schemeIdFor(party.taxNumber)}">${escapeXml(party.taxNumber.trim())}</cbc:ID>`,
    '</cac:PartyIdentification>',
    '<cac:PartyName>',
    `  <cbc:Name>${escapeXml(party.title)}</cbc:Name>`,
    '</cac:PartyName>',
    '<cac:PostalAddress>',
    `  <cbc:StreetName>${escapeXml(party.address ?? '')}</cbc:StreetName>`,
    `  <cbc:CitySubdivisionName>${escapeXml(party.district ?? '')}</cbc:CitySubdivisionName>`,
    `  <cbc:CityName>${escapeXml(party.city ?? '')}</cbc:CityName>`,
    '  <cac:Country>',
    `    <cbc:Name>${escapeXml(party.country ?? 'Türkiye')}</cbc:Name>`,
    '  </cac:Country>',
    '</cac:PostalAddress>',
    '<cac:PartyTaxScheme>',
    '  <cac:TaxScheme>',
    `    <cbc:Name>${escapeXml(party.taxOffice ?? '')}</cbc:Name>`,
    '  </cac:TaxScheme>',
    '</cac:PartyTaxScheme>',
  ];

  if (party.phone || party.email) {
    satirlar.push('<cac:Contact>');
    if (party.phone) satirlar.push(`  <cbc:Telephone>${escapeXml(party.phone)}</cbc:Telephone>`);
    if (party.email) satirlar.push(`  <cbc:ElectronicMail>${escapeXml(party.email)}</cbc:ElectronicMail>`);
    satirlar.push('</cac:Contact>');
  }

  return satirlar.map((satir) => `${girinti}${satir}`).join('\n');
}

interface VatGroup {
  rate: number;
  taxableAmount: number;
  taxAmount: number;
}

/**
 * KDV matrahlarini ORANA GORE gruplar.
 *
 * Gruplama YUVARLANMIS satir degerleri uzerinden yapilir: once toplayip sonra
 * yuvarlamak, satirlarin toplamiyla tutmayan bir matrah uretebilir ve GIB'in
 * kontrol ettigi ilk sey bu esitliktir.
 */
function groupVat(lines: readonly UblLine[]): VatGroup[] {
  const gruplar = new Map<number, VatGroup>();

  for (const satir of lines) {
    const oran = round(satir.vatRate);
    const mevcut = gruplar.get(oran) ?? { rate: oran, taxableAmount: 0, taxAmount: 0 };

    mevcut.taxableAmount = round(mevcut.taxableAmount + round(satir.netAmount));
    mevcut.taxAmount = round(mevcut.taxAmount + round(satir.vatAmount));
    gruplar.set(oran, mevcut);
  }

  return [...gruplar.values()].sort((a, b) => a.rate - b.rate);
}

function taxSubtotalXml(grup: VatGroup, currency: string, girinti: string): string {
  const para = ` currencyID="${currency}"`;

  return [
    '<cac:TaxSubtotal>',
    `  <cbc:TaxableAmount${para}>${formatAmount(grup.taxableAmount)}</cbc:TaxableAmount>`,
    `  <cbc:TaxAmount${para}>${formatAmount(grup.taxAmount)}</cbc:TaxAmount>`,
    `  <cbc:Percent>${formatAmount(grup.rate)}</cbc:Percent>`,
    '  <cac:TaxCategory>',
    '    <cac:TaxScheme>',
    '      <cbc:Name>KDV</cbc:Name>',
    /* 0015: Katma Deger Vergisi. Vergi turu kodu, GIB'in vergi kodlari
       listesinden gelir ve serbest metin degildir. */
    '      <cbc:TaxTypeCode>0015</cbc:TaxTypeCode>',
    '    </cac:TaxScheme>',
    '  </cac:TaxCategory>',
    '</cac:TaxSubtotal>',
  ]
    .map((satir) => `${girinti}${satir}`)
    .join('\n');
}

function invoiceLineXml(
  satir: UblLine,
  currency: string,
  birimKodu: string,
  girinti: string,
): string {
  const para = ` currencyID="${currency}"`;
  const parcalar: string[] = [
    '<cac:InvoiceLine>',
    `  <cbc:ID>${satir.lineNumber}</cbc:ID>`,
    satir.note ? `  <cbc:Note>${escapeXml(satir.note)}</cbc:Note>` : null,
    `  <cbc:InvoicedQuantity unitCode="${birimKodu}">${formatQuantity(satir.quantity)}</cbc:InvoicedQuantity>`,
    /* Satir tutari ISKONTO SONRASIDIR. Iskonto ayrica AllowanceCharge olarak
       da yazilir; ikisi birlikte "ne kadar indirim yapildigi" sorusunu belge
       uzerinde cevaplar. */
    `  <cbc:LineExtensionAmount${para}>${formatAmount(satir.netAmount)}</cbc:LineExtensionAmount>`,
  ].filter((parca): parca is string => parca !== null);

  if (round(satir.discountTotal) > 0) {
    parcalar.push(
      '  <cac:AllowanceCharge>',
      '    <cbc:ChargeIndicator>false</cbc:ChargeIndicator>',
      `    <cbc:Amount${para}>${formatAmount(satir.discountTotal)}</cbc:Amount>`,
      `    <cbc:BaseAmount${para}>${formatAmount(satir.grossAmount)}</cbc:BaseAmount>`,
      '  </cac:AllowanceCharge>',
    );
  }

  parcalar.push(
    '  <cac:TaxTotal>',
    `    <cbc:TaxAmount${para}>${formatAmount(satir.vatAmount)}</cbc:TaxAmount>`,
    taxSubtotalXml(
      { rate: round(satir.vatRate), taxableAmount: round(satir.netAmount), taxAmount: round(satir.vatAmount) },
      currency,
      '    ',
    ),
    '  </cac:TaxTotal>',
    '  <cac:Item>',
    `    <cbc:Name>${escapeXml(satir.productName)}</cbc:Name>`,
    '    <cac:SellersItemIdentification>',
    `      <cbc:ID>${escapeXml(satir.productCode)}</cbc:ID>`,
    '    </cac:SellersItemIdentification>',
    '  </cac:Item>',
    '  <cac:Price>',
    `    <cbc:PriceAmount${para}>${satir.unitPrice.toFixed(4)}</cbc:PriceAmount>`,
    '  </cac:Price>',
    '</cac:InvoiceLine>',
  );

  return parcalar.map((parca) => `${girinti}${parca}`).join('\n');
}

// ---------------------------------------------------------------------------
// Fatura
// ---------------------------------------------------------------------------

export function buildInvoiceXml(input: UblDocumentInput): UblBuildResult {
  if (input.kind === EDocumentKind.EDESPATCH) {
    throw new Error('e-İrsaliye için buildDespatchAdviceXml kullanılır.');
  }

  const uyarilar = dogrula(input);
  const currency = input.currency.toUpperCase();
  const para = ` currencyID="${currency}"`;

  const kdvGruplari = groupVat(input.lines);

  const netToplam = input.lines.reduce((toplam, satir) => round(toplam + round(satir.netAmount)), 0);
  const kdvToplam = kdvGruplari.reduce((toplam, grup) => round(toplam + grup.taxAmount), 0);
  const iskontoToplam = input.lines.reduce(
    (toplam, satir) => round(toplam + round(satir.discountTotal)),
    0,
  );
  const genelToplam = round(netToplam + kdvToplam);

  /* Belge toplami portalin bildigi toplamla TUTMALIDIR. Tutmuyorsa bir taraf
     yaniliyordur ve hangisi oldugu belli degildir; iki farkli tutar tasiyan
     bir fatura, muhasebede saatlerce aranan bir farktir. */
  if (
    input.expectedGrandTotal !== null &&
    input.expectedGrandTotal !== undefined &&
    Math.abs(genelToplam - round(input.expectedGrandTotal)) > TOLERANCE
  ) {
    throw new Error(
      `Belge toplamı tutmuyor: satırlardan ${formatAmount(genelToplam)}, ` +
        `kayıttan ${formatAmount(input.expectedGrandTotal)} çıkıyor. Belge üretilmedi.`,
    );
  }

  const satirlar: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"',
    '         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"',
    '         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">',
    '  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>',
    '  <cbc:CustomizationID>TR1.2</cbc:CustomizationID>',
    `  <cbc:ProfileID>${profileId(input.kind)}</cbc:ProfileID>`,
    `  <cbc:ID>${escapeXml(input.documentNumber)}</cbc:ID>`,
    '  <cbc:CopyIndicator>false</cbc:CopyIndicator>',
    `  <cbc:UUID>${escapeXml(input.uuid)}</cbc:UUID>`,
    `  <cbc:IssueDate>${formatDate(input.issuedAt)}</cbc:IssueDate>`,
    `  <cbc:IssueTime>${formatTime(input.issuedAt)}</cbc:IssueTime>`,
    '  <cbc:InvoiceTypeCode>SATIS</cbc:InvoiceTypeCode>',
    input.note ? `  <cbc:Note>${escapeXml(input.note)}</cbc:Note>` : null,
    `  <cbc:DocumentCurrencyCode>${escapeXml(currency)}</cbc:DocumentCurrencyCode>`,
    `  <cbc:LineCountNumeric>${input.lines.length}</cbc:LineCountNumeric>`,
  ].filter((satir): satir is string => satir !== null);

  if (input.orderNumber) {
    satirlar.push(
      '  <cac:OrderReference>',
      `    <cbc:ID>${escapeXml(input.orderNumber)}</cbc:ID>`,
      `    <cbc:IssueDate>${formatDate(input.orderDate ?? input.issuedAt)}</cbc:IssueDate>`,
      '  </cac:OrderReference>',
    );
  }

  satirlar.push(
    '  <cac:AccountingSupplierParty>',
    '    <cac:Party>',
    partyXml(input.supplier, '      '),
    '    </cac:Party>',
    '  </cac:AccountingSupplierParty>',
    '  <cac:AccountingCustomerParty>',
    '    <cac:Party>',
    partyXml(input.customer, '      '),
    '    </cac:Party>',
    '  </cac:AccountingCustomerParty>',
    '  <cac:TaxTotal>',
    `    <cbc:TaxAmount${para}>${formatAmount(kdvToplam)}</cbc:TaxAmount>`,
    ...kdvGruplari.map((grup) => taxSubtotalXml(grup, currency, '    ')),
    '  </cac:TaxTotal>',
    '  <cac:LegalMonetaryTotal>',
    /* LineExtensionAmount satirlarin ISKONTOLU (net) toplamidir; iskonto satir
       duzeyinde uygulandigi icin belge duzeyinde AllowanceTotalAmount olarak
       TEKRAR DUSULMEZ - dusulseydi matrah iki kez azalirdi. Alan yine de
       yazilir: mali musavir "ne kadar iskonto yapildi" sorusunu belgenin
       kendisinden cevaplayabilmelidir. */
    `    <cbc:LineExtensionAmount${para}>${formatAmount(netToplam)}</cbc:LineExtensionAmount>`,
    `    <cbc:TaxExclusiveAmount${para}>${formatAmount(netToplam)}</cbc:TaxExclusiveAmount>`,
    `    <cbc:TaxInclusiveAmount${para}>${formatAmount(genelToplam)}</cbc:TaxInclusiveAmount>`,
    `    <cbc:AllowanceTotalAmount${para}>${formatAmount(iskontoToplam)}</cbc:AllowanceTotalAmount>`,
    `    <cbc:PayableAmount${para}>${formatAmount(genelToplam)}</cbc:PayableAmount>`,
    '  </cac:LegalMonetaryTotal>',
  );

  for (const satir of input.lines) {
    const birim = unitCodeFor(satir.unitCode);

    if (!birim.known) {
      uyarilar.push(
        `${satir.lineNumber}. satırda tanınmayan birim "${satir.unitCode}"; belgeye adet (C62) yazıldı.`,
      );
    }

    satirlar.push(invoiceLineXml(satir, currency, birim.code, '  '));
  }

  satirlar.push('</Invoice>');

  return {
    xml: satirlar.join('\n'),
    totals: {
      lineExtensionAmount: netToplam,
      taxExclusiveAmount: netToplam,
      taxAmount: kdvToplam,
      taxInclusiveAmount: genelToplam,
      allowanceTotalAmount: iskontoToplam,
    },
    warnings: uyarilar,
  };
}

// ---------------------------------------------------------------------------
// e-Irsaliye
// ---------------------------------------------------------------------------

/**
 * e-Irsaliye faturadan AYRI bir belgedir ve tutar TASIMAZ.
 *
 * Irsaliyeye tutar yazmak, malin tesliminde bulunan depo gorevlisinin ve
 * soforun eline fiyat listesi vermektir; sevk belgesinin isi mali degil
 * miktari belgelemektir.
 */
export function buildDespatchAdviceXml(input: UblDocumentInput): UblBuildResult {
  if (input.kind !== EDocumentKind.EDESPATCH) {
    throw new Error('Fatura belgeleri için buildInvoiceXml kullanılır.');
  }

  const uyarilar = dogrula(input);
  const sevkZamani = input.despatchAt ?? input.issuedAt;

  const satirlar: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<DespatchAdvice xmlns="urn:oasis:names:specification:ubl:schema:xsd:DespatchAdvice-2"',
    '                xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"',
    '                xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">',
    '  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>',
    '  <cbc:CustomizationID>TR1.2</cbc:CustomizationID>',
    `  <cbc:ProfileID>${profileId(input.kind)}</cbc:ProfileID>`,
    `  <cbc:ID>${escapeXml(input.documentNumber)}</cbc:ID>`,
    '  <cbc:CopyIndicator>false</cbc:CopyIndicator>',
    `  <cbc:UUID>${escapeXml(input.uuid)}</cbc:UUID>`,
    `  <cbc:IssueDate>${formatDate(input.issuedAt)}</cbc:IssueDate>`,
    `  <cbc:IssueTime>${formatTime(input.issuedAt)}</cbc:IssueTime>`,
    '  <cbc:DespatchAdviceTypeCode>SEVK</cbc:DespatchAdviceTypeCode>',
    input.note ? `  <cbc:Note>${escapeXml(input.note)}</cbc:Note>` : null,
    `  <cbc:LineCountNumeric>${input.lines.length}</cbc:LineCountNumeric>`,
  ].filter((satir): satir is string => satir !== null);

  if (input.orderNumber) {
    satirlar.push(
      '  <cac:OrderReference>',
      `    <cbc:ID>${escapeXml(input.orderNumber)}</cbc:ID>`,
      `    <cbc:IssueDate>${formatDate(input.orderDate ?? input.issuedAt)}</cbc:IssueDate>`,
      '  </cac:OrderReference>',
    );
  }

  satirlar.push(
    '  <cac:DespatchSupplierParty>',
    '    <cac:Party>',
    partyXml(input.supplier, '      '),
    '    </cac:Party>',
    '  </cac:DespatchSupplierParty>',
    '  <cac:DeliveryCustomerParty>',
    '    <cac:Party>',
    partyXml(input.customer, '      '),
    '    </cac:Party>',
    '  </cac:DeliveryCustomerParty>',
    '  <cac:Shipment>',
    '    <cbc:ID>1</cbc:ID>',
    '    <cac:Delivery>',
    '      <cac:Despatch>',
    `        <cbc:ActualDespatchDate>${formatDate(sevkZamani)}</cbc:ActualDespatchDate>`,
    `        <cbc:ActualDespatchTime>${formatTime(sevkZamani)}</cbc:ActualDespatchTime>`,
    '      </cac:Despatch>',
    '    </cac:Delivery>',
    '  </cac:Shipment>',
  );

  for (const satir of input.lines) {
    const birim = unitCodeFor(satir.unitCode);

    if (!birim.known) {
      uyarilar.push(
        `${satir.lineNumber}. satırda tanınmayan birim "${satir.unitCode}"; belgeye adet (C62) yazıldı.`,
      );
    }

    satirlar.push(
      '  <cac:DespatchLine>',
      `    <cbc:ID>${satir.lineNumber}</cbc:ID>`,
      `    <cbc:DeliveredQuantity unitCode="${birim.code}">${formatQuantity(satir.quantity)}</cbc:DeliveredQuantity>`,
      '    <cac:Item>',
      `      <cbc:Name>${escapeXml(satir.productName)}</cbc:Name>`,
      '      <cac:SellersItemIdentification>',
      `        <cbc:ID>${escapeXml(satir.productCode)}</cbc:ID>`,
      '      </cac:SellersItemIdentification>',
      '    </cac:Item>',
      '  </cac:DespatchLine>',
    );
  }

  satirlar.push('</DespatchAdvice>');

  return {
    xml: satirlar.join('\n'),
    totals: {
      lineExtensionAmount: 0,
      taxExclusiveAmount: 0,
      taxAmount: 0,
      taxInclusiveAmount: 0,
      allowanceTotalAmount: 0,
    },
    warnings: uyarilar,
  };
}

// ---------------------------------------------------------------------------
// Dogrulama
// ---------------------------------------------------------------------------

/**
 * Belgeyi entegratore GONDERMEDEN ONCE reddedilecegi belli olan durumlar.
 *
 * Reddi entegratorden ogrenmek, kullaniciya saatler sonra ve anlasilmaz bir
 * hata koduyla donen bir surectir; burada durdurmak, ayni hatayi belgeyi
 * kesen kisinin ekraninda anlasilir bir cumleyle gostermektir.
 */
function dogrula(input: UblDocumentInput): string[] {
  const uyarilar: string[] = [];

  if (!/^[A-ZÇĞİÖŞÜ]{3}\d{13}$/.test(input.documentNumber)) {
    throw new Error(
      `Belge numarası GİB biçiminde değil (3 harf + 13 hane): ${input.documentNumber}`,
    );
  }

  if (input.lines.length === 0) {
    throw new Error('Belge en az bir satır içermelidir.');
  }

  for (const taraf of [input.supplier, input.customer]) {
    const vergiNo = taraf.taxNumber.trim();

    /* VKN/TCKN eksik veya hatali bir belge, entegratorde degil GIB'de
       reddedilir ve o noktada belge numarasi TUKENMISTIR - iptal edilmis bir
       numara olarak defterde durur. */
    if (!/^\d{10}$|^\d{11}$/.test(vergiNo)) {
      throw new Error(
        `${taraf.title} için VKN/TCKN geçersiz ("${vergiNo}"). Belge üretilmedi.`,
      );
    }

    if (!taraf.taxOffice) {
      uyarilar.push(`${taraf.title} için vergi dairesi boş gönderiliyor.`);
    }
  }

  for (const satir of input.lines) {
    if (satir.quantity <= 0) {
      throw new Error(`${satir.lineNumber}. satırda miktar sıfır veya negatif.`);
    }

    if (Math.abs(round(satir.grossAmount - satir.discountTotal) - round(satir.netAmount)) > TOLERANCE) {
      throw new Error(
        `${satir.lineNumber}. satırda tutar tutmuyor: brüt - iskonto ≠ net.`,
      );
    }
  }

  return uyarilar;
}
