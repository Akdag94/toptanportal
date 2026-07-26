/**
 * Bicimlendirme testleri.
 *
 * En kritik kural: KOR SIPARIS MODUNDA TUTAR ALANI GELMEZ ve arayuz bu durumda
 * "0,00 TL" GOSTERMEZ. Sifir tutar gostermek, gizlenmis bir fiyati gercek bir
 * bedel gibi sunmaktir; musteri bunu bedava zannedebilir. Bu testin kirilmasi
 * urun kararinin degistigi anlamina gelir, kod incelemesinde tartisilmalidir.
 */

import { describe, expect, it } from 'vitest';

import { gun, miktar, para, tarihSaat, yuzde } from './bicim';

describe('para', () => {
  it('tutar gelmediğinde null döner — sıfır DEĞİL', () => {
    expect(para(undefined)).toBeNull();
  });

  it('gerçek sıfır tutarı gösterir — "gönderilmedi" ile karıştırmaz', () => {
    expect(para(0)).not.toBeNull();
    expect(para(0)).toContain('0,00');
  });

  it('geçersiz sayıyı gizler', () => {
    expect(para(Number.NaN)).toBeNull();
    expect(para(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('Türkçe biçimde binlik ayracı ve iki ondalık kullanır', () => {
    const bicimlenmis = para(69705.99);

    expect(bicimlenmis).toContain('69.705,99');
    expect(bicimlenmis).toContain('₺');
  });

  it('para birimini yanıttan alır', () => {
    expect(para(100, 'USD')).toContain('$');
    expect(para(100, 'EUR')).toContain('€');
  });

  it('yarım kuruşu iki ondalığa yuvarlar', () => {
    expect(para(2.005)).toContain('2,01');
  });
});

describe('miktar', () => {
  it('tam sayıda gereksiz ondalık göstermez', () => {
    expect(miktar(25)).toBe('25');
  });

  it('kesirli miktarı dört haneye kadar korur', () => {
    expect(miktar(1.5)).toBe('1,5');
    expect(miktar(0.0625)).toBe('0,0625');
  });
});

describe('yuzde', () => {
  it('tam oranı sade gösterir', () => {
    expect(yuzde(5)).toBe('%5');
  });

  it('kesirli oranı Türkçe ondalık ayracıyla gösterir', () => {
    expect(yuzde(7.5)).toBe('%7,5');
  });
});

describe('tarih', () => {
  it('gün alanı boşsa çizgi döner', () => {
    expect(gun(null)).toBe('—');
  });

  it('ISO tarihi gün/ay/yıl olarak gösterir', () => {
    expect(gun('2026-07-26T00:00:00.000Z')).toMatch(/^\d{2}\.\d{2}\.2026$/);
  });

  it('tarih ve saati birlikte gösterir', () => {
    expect(tarihSaat('2026-07-26T09:30:00.000Z')).toMatch(/^\d{2}\.\d{2}\.2026 \d{2}:\d{2}$/);
  });
});
