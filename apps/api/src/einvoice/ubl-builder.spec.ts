/**
 * UBL-TR belge uretimi testleri.
 *
 * Uretilen XML HUKUKI ASILDIR: ihtilafta mahkemeye bu dosya sunulur. Bu
 * dosyanin isi, belgenin kendi icinde tutarli oldugunu ve gecersiz bir
 * belgenin HIC URETILMEDIGINI kilitlemektir - gecersiz belge, uretilmemis
 * belgeden pahalidir cunku belge numarasini tuketir.
 */

import { EDocumentKind } from '@toptanportal/contracts';

import {
  buildDespatchAdviceXml,
  buildInvoiceXml,
  escapeXml,
  unitCodeFor,
  type UblDocumentInput,
  type UblLine,
} from './ubl-builder';

const SATICI = {
  taxNumber: '1234567890',
  title: 'Marmara Toptan Gıda A.Ş.',
  taxOffice: 'Kadıköy',
  address: 'Sanayi Cad. No:12',
  district: 'Kadıköy',
  city: 'İstanbul',
};

const ALICI = {
  taxNumber: '9876543210',
  title: 'Mavi Kapı Otelcilik Ltd. Şti.',
  taxOffice: 'Beşiktaş',
  address: 'Sahil Yolu No:3',
  district: 'Beşiktaş',
  city: 'İstanbul',
};

const SATIR: UblLine = {
  lineNumber: 1,
  productCode: 'KHV-001',
  productName: 'Filtre Kahve 1 kg',
  unitCode: 'KOLI',
  quantity: 10,
  unitPrice: 100,
  grossAmount: 1000,
  discountTotal: 0,
  netAmount: 1000,
  vatRate: 20,
  vatAmount: 200,
};

function belge(ekler: Partial<UblDocumentInput> = {}): UblDocumentInput {
  return {
    kind: EDocumentKind.EINVOICE,
    documentNumber: 'MRM2026000000431',
    uuid: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    issuedAt: new Date('2026-08-01T10:15:00.000Z'),
    currency: 'TRY',
    supplier: SATICI,
    customer: ALICI,
    lines: [SATIR],
    ...ekler,
  };
}

describe('fatura aritmetiği', () => {
  it('belge toplamı satırlardan hesaplanır', () => {
    const { xml, totals } = buildInvoiceXml(belge());

    expect(totals.taxExclusiveAmount).toBe(1000);
    expect(totals.taxAmount).toBe(200);
    expect(totals.taxInclusiveAmount).toBe(1200);
    expect(xml).toContain('<cbc:PayableAmount currencyID="TRY">1200.00</cbc:PayableAmount>');
  });

  it('KDV matrahları orana göre gruplanır', () => {
    const { xml } = buildInvoiceXml(
      belge({
        lines: [
          SATIR,
          {
            ...SATIR,
            lineNumber: 2,
            productCode: 'SU-005',
            productName: 'Doğal Kaynak Suyu 0,5 L',
            unitCode: 'KOLI',
            quantity: 5,
            unitPrice: 40,
            grossAmount: 200,
            netAmount: 200,
            vatRate: 10,
            vatAmount: 20,
          },
        ],
      }),
    );

    // Iki ayri oran, iki ayri matrah satiri. Tek bir toplam KDV satiri hangi
    // matrahin hangi oranla vergilendigini gizlerdi.
    expect(xml).toContain('<cbc:Percent>10.00</cbc:Percent>');
    expect(xml).toContain('<cbc:Percent>20.00</cbc:Percent>');
    expect(xml).toContain('<cbc:TaxableAmount currencyID="TRY">200.00</cbc:TaxableAmount>');
    expect(xml).toContain('<cbc:TaxAmount currencyID="TRY">220.00</cbc:TaxAmount>');
  });

  it('portalin bildiği toplamla tutmayan belge üretilmez', () => {
    // Iki farkli tutar tasiyan bir fatura, muhasebede saatlerce aranan bir
    // farktir; belgeyi hic uretmemek dogru davranistir.
    expect(() => buildInvoiceXml(belge({ expectedGrandTotal: 1500 }))).toThrow(/tutmuyor/);
  });

  it('portalin bildiği toplamla tutan belge üretilir', () => {
    expect(() => buildInvoiceXml(belge({ expectedGrandTotal: 1200 }))).not.toThrow();
  });

  it('satır içinde brüt - iskonto ≠ net ise belge üretilmez', () => {
    expect(() =>
      buildInvoiceXml(belge({ lines: [{ ...SATIR, discountTotal: 100 }] })),
    ).toThrow(/tutar tutmuyor/);
  });

  it('iskonto satırda hem indirilmiş hem yazılı durur', () => {
    const { xml, totals } = buildInvoiceXml(
      belge({
        lines: [{ ...SATIR, discountTotal: 100, netAmount: 900, vatAmount: 180 }],
      }),
    );

    expect(xml).toContain('<cbc:ChargeIndicator>false</cbc:ChargeIndicator>');
    expect(xml).toContain('<cbc:Amount currencyID="TRY">100.00</cbc:Amount>');
    expect(xml).toContain(
      '<cbc:LineExtensionAmount currencyID="TRY">900.00</cbc:LineExtensionAmount>',
    );
    // Iskonto satir duzeyinde uygulandi; matrah ikinci kez azaltilmaz.
    expect(totals.taxExclusiveAmount).toBe(900);
    expect(totals.allowanceTotalAmount).toBe(100);
  });
});

describe('geçersiz belge üretilmez', () => {
  it('GİB biçimine uymayan belge numarasını reddeder', () => {
    expect(() => buildInvoiceXml(belge({ documentNumber: 'MRM-2026-431' }))).toThrow(
      /Belge numarası/,
    );
  });

  it('geçersiz VKN ile üretmez — numara tükenmeden durur', () => {
    expect(() =>
      buildInvoiceXml(belge({ customer: { ...ALICI, taxNumber: '123' } })),
    ).toThrow(/VKN\/TCKN/);
  });

  it('TCKN 11 hanedir ve şema tanımlayıcısı ona göre yazılır', () => {
    const { xml } = buildInvoiceXml(
      belge({ customer: { ...ALICI, taxNumber: '12345678901' } }),
    );

    expect(xml).toContain('<cbc:ID schemeID="TCKN">12345678901</cbc:ID>');
    expect(xml).toContain('<cbc:ID schemeID="VKN">1234567890</cbc:ID>');
  });

  it('satırsız belge üretmez', () => {
    expect(() => buildInvoiceXml(belge({ lines: [] }))).toThrow(/en az bir satır/);
  });

  it('sıfır miktarlı satırı reddeder', () => {
    expect(() => buildInvoiceXml(belge({ lines: [{ ...SATIR, quantity: 0 }] }))).toThrow(
      /miktar/,
    );
  });
});

describe('XML kaçışı', () => {
  it('ünvandaki & işareti belgeyi bozmaz', () => {
    const { xml } = buildInvoiceXml(
      belge({ customer: { ...ALICI, title: 'A&B Gıda <Ltd> "Şti"' } }),
    );

    expect(xml).toContain('A&amp;B Gıda &lt;Ltd&gt; &quot;Şti&quot;');
    expect(xml).not.toContain('A&B');
  });

  it('escapeXml apostrofu da kaçırır — öznitelik değeri olabilir', () => {
    expect(escapeXml(`O'Neill & Co`)).toBe('O&apos;Neill &amp; Co');
  });
});

describe('birim kodu', () => {
  it('koli BX, kilogram KGM olur', () => {
    expect(unitCodeFor('KOLI')).toEqual({ code: 'BX', known: true });
    expect(unitCodeFor('kg')).toEqual({ code: 'KGM', known: true });
  });

  it('tanınmayan birimde belge üretilir ama uyarı döner', () => {
    // Faturayi hic kesememek, yanlis birim kodundan buyuk bir zarardir;
    // uyari operatorun gorebilecegi bir yere dusmelidir.
    const { warnings, xml } = buildInvoiceXml(
      belge({ lines: [{ ...SATIR, unitCode: 'DEMET' }] }),
    );

    expect(warnings.some((uyari) => uyari.includes('DEMET'))).toBe(true);
    expect(xml).toContain('unitCode="C62"');
  });
});

describe('belge türü', () => {
  it('e-Fatura ticari profille üretilir — alıcının ret hakkı belgede durur', () => {
    expect(buildInvoiceXml(belge()).xml).toContain('<cbc:ProfileID>TICARIFATURA</cbc:ProfileID>');
  });

  it('e-Arşiv faturası kendi profiliyle üretilir', () => {
    const { xml } = buildInvoiceXml(belge({ kind: EDocumentKind.EARCHIVE }));
    expect(xml).toContain('<cbc:ProfileID>EARSIVFATURA</cbc:ProfileID>');
  });

  it('e-İrsaliye fatura üreticisinden geçmez', () => {
    expect(() => buildInvoiceXml(belge({ kind: EDocumentKind.EDESPATCH }))).toThrow(
      /buildDespatchAdviceXml/,
    );
  });
});

describe('e-İrsaliye', () => {
  const irsaliye = belge({
    kind: EDocumentKind.EDESPATCH,
    documentNumber: 'MRM2026000000432',
    despatchAt: new Date('2026-08-02T06:30:00.000Z'),
  });

  it('tutar taşımaz — sevk belgesinin işi miktarı belgelemektir', () => {
    const { xml } = buildDespatchAdviceXml(irsaliye);

    expect(xml).not.toContain('PayableAmount');
    expect(xml).not.toContain('LineExtensionAmount');
    expect(xml).not.toContain('1000.00');
  });

  it('fiili sevk zamanını taşır', () => {
    const { xml } = buildDespatchAdviceXml(irsaliye);

    expect(xml).toContain('<cbc:ActualDespatchDate>2026-08-02</cbc:ActualDespatchDate>');
    expect(xml).toContain('<cbc:DespatchAdviceTypeCode>SEVK</cbc:DespatchAdviceTypeCode>');
  });

  it('miktar ve birim satırda durur', () => {
    const { xml } = buildDespatchAdviceXml(irsaliye);
    expect(xml).toContain('<cbc:DeliveredQuantity unitCode="BX">10</cbc:DeliveredQuantity>');
  });

  it('fatura irsaliye üreticisinden geçmez', () => {
    expect(() => buildDespatchAdviceXml(belge())).toThrow(/buildInvoiceXml/);
  });
});

describe('sipariş bağı', () => {
  it('faturayı doğuran sipariş belgeye yazılır', () => {
    const { xml } = buildInvoiceXml(
      belge({ orderNumber: 'SP-2026-000418', orderDate: new Date('2026-07-30T00:00:00.000Z') }),
    );

    expect(xml).toContain('<cbc:ID>SP-2026-000418</cbc:ID>');
    expect(xml).toContain('<cbc:IssueDate>2026-07-30</cbc:IssueDate>');
  });
});
