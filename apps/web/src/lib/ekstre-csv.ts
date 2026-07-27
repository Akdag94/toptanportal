/**
 * ToptanPortal Web - Ekstre Disa Aktarimi
 *
 * Hedef program Excel'in Turkce yerel ayaridir; bu iki karari zorunlu kilar:
 *
 *   1. AYRAC NOKTALI VIRGULDUR. Turkce Excel ondalik ayraci olarak virgul
 *      kullanir; virgulle ayrilmis dosyayi acarken her tutari iki sutuna boler.
 *   2. Dosya BOM ile baslar. BOM'suz UTF-8 dosyayi Excel yerel kod sayfasiyla
 *      okur ve Turkce karakterler bozulur ("Fatura" -> "FaturaÄ±").
 *
 * Tutarlar ondalik VIRGULLE, binlik ayraci OLMADAN yazilir: binlik ayraci
 * Excel'de metin olarak algilanip toplama sokulamayan bir hucre uretir.
 * Muhasebeci bu dosyayi mutabakat icin toplar - okumak icin degil.
 */

import type { AccountEntry, StatementPage } from '@toptanportal/contracts';

const BASLIKLAR = [
  'Belge No',
  'Tür',
  'Tarih',
  'Vade',
  'Açıklama',
  'Borç',
  'Alacak',
  'Kalan',
  'Yürüyen Bakiye',
  'Gecikme (gün)',
] as const;

/** Excel'in sayi olarak okuyabilecegi bicim: 1234.5 -> "1234,50" */
function tutar(deger: number): string {
  return deger.toFixed(2).replace('.', ',');
}

/**
 * Bir hucreyi kacirir. Noktali virgul, cift tirnak veya satir sonu iceren
 * deger tirnaklanir; ictek tirnak ikilenir (RFC 4180).
 *
 * Ayrica `=`, `+`, `-`, `@` ile baslayan degerlerin onune tek tirnak konur:
 * Excel bunlari FORMUL olarak yorumlar ve acan makinede calistirir. Ekstre
 * aciklamasi kullanicidan gelen metin tasiyabilir; formul enjeksiyonu icin
 * acik bir kapi birakmayiz.
 */
export function hucre(deger: string): string {
  const guvenli = /^[=+\-@\t\r]/.test(deger) ? `'${deger}` : deger;

  return /[";\n\r]/.test(guvenli) ? `"${guvenli.replace(/"/g, '""')}"` : guvenli;
}

function satir(hareket: AccountEntry): string {
  return [
    hucre(hareket.documentNumber),
    hucre(hareket.kindLabel),
    hucre(hareket.entryDate.slice(0, 10)),
    hucre(hareket.dueDate?.slice(0, 10) ?? ''),
    hucre(hareket.description ?? ''),
    tutar(hareket.debit),
    tutar(hareket.credit),
    tutar(hareket.openAmount),
    tutar(hareket.runningBalance),
    String(hareket.overdueDays),
  ].join(';');
}

/**
 * Ekstreyi CSV metnine cevirir. Donem devri ilk satir olarak yazilir: devirsiz
 * bir ekstrede yuruyen bakiye sutunu, hareketlerin toplamiyla tutmaz ve dosyayi
 * acan kisi bunu hata sanir.
 */
export function ekstreCsv(sayfa: StatementPage): string {
  const satirlar = [
    BASLIKLAR.join(';'),
    [
      hucre('DEVİR'),
      hucre('Dönem Başı'),
      hucre(sayfa.from),
      '',
      hucre(`${sayfa.companyTitle} · ${sayfa.from} – ${sayfa.to}`),
      '',
      '',
      '',
      tutar(sayfa.openingBalance),
      '0',
    ].join(';'),
    ...sayfa.entries.map(satir),
  ];

  return `﻿${satirlar.join('\r\n')}\r\n`;
}

export function ekstreDosyaAdi(sayfa: StatementPage): string {
  const temizUnvan = sayfa.companyTitle.replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 40);
  return `ekstre-${temizUnvan}-${sayfa.from}_${sayfa.to}.csv`;
}
