/**
 * Ekstre disa aktarim testleri.
 *
 * En kritik iki kural: formul enjeksiyonu ve ayrac secimi. Ikisi de sessizce
 * bozulur - dosya acilir, kimse hata gormez, rakamlar yanlistir.
 */

import { describe, expect, it } from 'vitest';
import type { AccountEntry, StatementPage } from '@toptanportal/contracts';

import { ekstreCsv, ekstreDosyaAdi, hucre } from './ekstre-csv';

function hareket(ekle: Partial<AccountEntry> = {}): AccountEntry {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'INVOICE',
    kindLabel: 'Satış Faturası',
    entryDate: '2026-07-02T00:00:00.000Z',
    dueDate: '2026-08-01T00:00:00.000Z',
    documentNumber: 'FTR2026000431',
    description: 'Temmuz sevkiyatı',
    debit: 18450.5,
    credit: 0,
    openAmount: 18450.5,
    runningBalance: 18450.5,
    currency: 'TRY',
    overdueDays: 0,
    orderId: null,
    ...ekle,
  };
}

function sayfa(ekle: Partial<StatementPage> = {}): StatementPage {
  return {
    companyId: '22222222-2222-4222-8222-222222222222',
    companyTitle: 'Mavi Kapı Otelcilik A.Ş.',
    from: '2026-07-01',
    to: '2026-07-31',
    openingBalance: 4200,
    closingBalance: 22650.5,
    debitTotal: 18450.5,
    creditTotal: 0,
    currency: 'TRY',
    entries: [hareket()],
    totalCount: 1,
    hasMore: false,
    ...ekle,
  };
}

describe('hucre', () => {
  it('formül karakteriyle başlayan değeri tek tırnakla etkisizleştirir', () => {
    // Excel bunu formül olarak yorumlar ve dosyayı açan makinede çalıştırır.
    expect(hucre('=1+1')).toBe("'=1+1");
    expect(hucre('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(hucre('-2+3')).toBe("'-2+3");
  });

  it('ayraç veya satır sonu içeren değeri tırnaklar', () => {
    expect(hucre('Depo; raf 3')).toBe('"Depo; raf 3"');
    expect(hucre('İki\nsatır')).toBe('"İki\nsatır"');
  });

  it('içteki tırnağı RFC 4180 gereği ikiler', () => {
    expect(hucre('15" tepsi')).toBe('"15"" tepsi"');
  });

  it('sıradan metne dokunmaz', () => {
    expect(hucre('Temmuz sevkiyatı')).toBe('Temmuz sevkiyatı');
  });
});

describe('ekstreCsv', () => {
  it('BOM ile başlar — BOM olmadan Excel Türkçe karakterleri bozar', () => {
    expect(ekstreCsv(sayfa()).charCodeAt(0)).toBe(0xfeff);
  });

  it('noktalı virgülle ayırır — Türkçe Excel virgülü ondalık sayar', () => {
    const satirlar = ekstreCsv(sayfa()).split('\r\n');
    expect(satirlar[0].split(';')).toHaveLength(10);
  });

  it('tutarı ondalık virgülle ve binlik ayracı olmadan yazar', () => {
    // "18.450,50" yazsaydık Excel hücreyi metin sayar ve toplayamazdı.
    expect(ekstreCsv(sayfa())).toContain('18450,50');
    expect(ekstreCsv(sayfa())).not.toContain('18.450');
  });

  it('dönem devrini ilk satır olarak yazar', () => {
    const satirlar = ekstreCsv(sayfa()).split('\r\n');
    expect(satirlar[1]).toContain('DEVİR');
    expect(satirlar[1]).toContain('4200,00');
  });

  it('boş vadeyi boş hücre olarak bırakır — "null" yazmaz', () => {
    const metin = ekstreCsv(sayfa({ entries: [hareket({ dueDate: null })] }));
    expect(metin).not.toContain('null');
  });
});

describe('ekstreDosyaAdi', () => {
  it('unvandaki noktalama işaretlerini dosya adından temizler', () => {
    expect(ekstreDosyaAdi(sayfa())).toBe(
      'ekstre-Mavi-Kapı-Otelcilik-A-Ş--2026-07-01_2026-07-31.csv',
    );
  });
});
