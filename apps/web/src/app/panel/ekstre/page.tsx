'use client';

/**
 * Cari Hesap Ekstresi
 *
 * Yuruyen bakiye SUNUCUDAN gelir; arayuz satirlari toplamaz. Sayfalanan bir
 * listede istemci tarafi toplam, ikinci sayfa yuklendiginde birinci sayfanin
 * devrini kaybeder ve sessizce yanlis bir bakiye gosterir.
 *
 * Sayfalama bu yuzden imlec degil OFSET kullanir: ekstre donem basindan
 * itibaren sirali okunmak zorundadir.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ACCOUNT_ENTRY_KIND_LABELS,
  AccountEntryKind,
  type AccountEntry,
  type AgingReport,
  type StatementPage,
} from '@toptanportal/contracts';

import { financeApi } from '../../../lib/api-client';
import { gun, para } from '../../../lib/bicim';
import { YaslandirmaKarti } from '../../../components/yaslandirma-karti';

const SAYFA_BOYU = 50;

interface Suzgec {
  from: string;
  to: string;
  kind: AccountEntryKind | '';
  onlyOpen: boolean;
}

const BOS_SUZGEC: Suzgec = { from: '', to: '', kind: '', onlyOpen: false };

export default function EkstreSayfasi() {
  const [suzgec, setSuzgec] = useState<Suzgec>(BOS_SUZGEC);
  const [uygulanan, setUygulanan] = useState<Suzgec>(BOS_SUZGEC);
  const [sayfa, setSayfa] = useState<StatementPage | null>(null);
  const [hareketler, setHareketler] = useState<AccountEntry[]>([]);
  const [yaslandirma, setYaslandirma] = useState<AgingReport | null>(null);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState<string | null>(null);

  const yukle = useCallback(
    async (ofset: number) => {
      setYukleniyor(true);
      setHata(null);

      try {
        const sonuc = await financeApi.statement({
          from: uygulanan.from || undefined,
          to: uygulanan.to || undefined,
          kind: uygulanan.kind || undefined,
          onlyOpen: uygulanan.onlyOpen || undefined,
          offset: ofset,
          limit: SAYFA_BOYU,
        });

        setSayfa(sonuc);
        setHareketler((oncekiler) =>
          ofset === 0 ? sonuc.entries : [...oncekiler, ...sonuc.entries],
        );
      } catch (error) {
        setHata(error instanceof Error ? error.message : 'Ekstre yüklenemedi.');
      } finally {
        setYukleniyor(false);
      }
    },
    [uygulanan],
  );

  useEffect(() => {
    void yukle(0);
  }, [yukle]);

  useEffect(() => {
    /* Yaslandirma donemden bagimsizdir - her zaman BUGUNKU acik borcu gosterir.
       Suzgec degistiginde yeniden cekmeye gerek yoktur. */
    financeApi
      .aging()
      .then(setYaslandirma)
      .catch(() => setYaslandirma(null));
  }, []);

  const acikBakiye = sayfa ? para(sayfa.openingBalance, sayfa.currency) : null;
  const kapanisBakiye = sayfa ? para(sayfa.closingBalance, sayfa.currency) : null;
  const borcToplam = sayfa ? para(sayfa.debitTotal, sayfa.currency) : null;
  const alacakToplam = sayfa ? para(sayfa.creditTotal, sayfa.currency) : null;

  return (
    <div>
      <div className="sayfa-baslik">
        <div>
          <h2>Ekstre ve Yaşlandırma</h2>
          <p>
            {sayfa
              ? `${sayfa.companyTitle} · ${gun(sayfa.from)} – ${gun(sayfa.to)} dönemi`
              : 'Hareket dökümü hazırlanıyor…'}
          </p>
        </div>
        <Link className="dugme dugme-ikincil dugme-kucuk" href="/panel/cari">
          Cari Özeti
        </Link>
      </div>

      <form
        className="arac-cubugu"
        onSubmit={(olay) => {
          olay.preventDefault();
          setUygulanan(suzgec);
        }}
      >
        <label className="alan-etiket" style={{ margin: 0 }}>
          Başlangıç
          <input
            className="alan-girdi"
            type="date"
            value={suzgec.from}
            onChange={(olay) => setSuzgec({ ...suzgec, from: olay.target.value })}
          />
        </label>

        <label className="alan-etiket" style={{ margin: 0 }}>
          Bitiş
          <input
            className="alan-girdi"
            type="date"
            value={suzgec.to}
            onChange={(olay) => setSuzgec({ ...suzgec, to: olay.target.value })}
          />
        </label>

        <label className="alan-etiket" style={{ margin: 0 }}>
          Hareket Türü
          <select
            className="secim"
            value={suzgec.kind}
            onChange={(olay) =>
              setSuzgec({ ...suzgec, kind: olay.target.value as AccountEntryKind | '' })
            }
          >
            <option value="">Tümü</option>
            {Object.entries(ACCOUNT_ENTRY_KIND_LABELS).map(([deger, etiket]) => (
              <option key={deger} value={deger}>
                {etiket}
              </option>
            ))}
          </select>
        </label>

        <label className="onay-etiket">
          <input
            type="checkbox"
            checked={suzgec.onlyOpen}
            onChange={(olay) => setSuzgec({ ...suzgec, onlyOpen: olay.target.checked })}
          />
          Yalnızca kapanmamış belgeler
        </label>

        <button className="dugme dugme-kucuk" type="submit" disabled={yukleniyor}>
          {yukleniyor ? 'Getiriliyor…' : 'Uygula'}
        </button>

        <button
          className="dugme dugme-ikincil dugme-kucuk"
          type="button"
          onClick={() => {
            setSuzgec(BOS_SUZGEC);
            setUygulanan(BOS_SUZGEC);
          }}
        >
          Temizle
        </button>
      </form>

      {hata && <div className="uyari-kutu hata">{hata}</div>}

      {sayfa && (
        <div className="olcum-izgara">
          <article className="olcum">
            <p className="olcum-etiket">Dönem Başı Devir</p>
            <p className="olcum-deger">{acikBakiye ?? '—'}</p>
          </article>
          <article className="olcum">
            <p className="olcum-etiket">Dönem Borç</p>
            <p className="olcum-deger borc">{borcToplam ?? '—'}</p>
          </article>
          <article className="olcum">
            <p className="olcum-etiket">Dönem Alacak</p>
            <p className="olcum-deger alacak">{alacakToplam ?? '—'}</p>
          </article>
          <article className="olcum">
            <p className="olcum-etiket">Dönem Sonu Bakiye</p>
            <p className={`olcum-deger ${sayfa.closingBalance > 0 ? 'borc' : 'alacak'}`}>
              {kapanisBakiye ?? '—'}
            </p>
          </article>
        </div>
      )}

      {hareketler.length === 0 && !yukleniyor ? (
        <div className="bos-durum">Bu dönemde hareket bulunmuyor.</div>
      ) : (
        <div className="liste">
          <div className="ekstre-satir baslik">
            <span>Belge</span>
            <span>Açıklama</span>
            <span className="ekstre-tutar">Borç</span>
            <span className="ekstre-tutar">Alacak</span>
            <span className="ekstre-tutar">Bakiye</span>
          </div>

          {hareketler.map((hareket) => {
            const borc = hareket.debit > 0 ? para(hareket.debit, hareket.currency) : null;
            const alacak = hareket.credit > 0 ? para(hareket.credit, hareket.currency) : null;
            const yuruyen = para(hareket.runningBalance, hareket.currency);
            const acik =
              hareket.openAmount > 0 ? para(hareket.openAmount, hareket.currency) : null;

            return (
              <div className="ekstre-satir" key={hareket.id}>
                <div>
                  <p className="urun-ad">
                    {hareket.orderId ? (
                      <Link href={`/panel/siparisler/${hareket.orderId}`}>
                        {hareket.documentNumber}
                      </Link>
                    ) : (
                      hareket.documentNumber
                    )}
                  </p>
                  <p className="urun-alt">
                    {hareket.kindLabel} · {gun(hareket.entryDate)}
                    {hareket.dueDate ? ` · Vade: ${gun(hareket.dueDate)}` : ''}
                  </p>
                  {hareket.overdueDays > 0 && (
                    <span className="gecikme-rozeti">{hareket.overdueDays} gün gecikmiş</span>
                  )}
                </div>

                <div>
                  <p className="urun-alt">{hareket.description ?? '—'}</p>
                  {acik && <p className="urun-alt">Kalan: {acik}</p>}
                </div>

                <span className="ekstre-tutar">{borc ?? '—'}</span>
                <span className="ekstre-tutar">{alacak ?? '—'}</span>
                <span className="ekstre-tutar yuruyen">{yuruyen ?? '—'}</span>
              </div>
            );
          })}
        </div>
      )}

      {sayfa?.hasMore && (
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <button
            type="button"
            className="dugme dugme-ikincil dugme-kucuk"
            disabled={yukleniyor}
            onClick={() => void yukle(hareketler.length)}
          >
            {yukleniyor
              ? 'Yükleniyor…'
              : `Daha Fazla Göster (${hareketler.length} / ${sayfa.totalCount})`}
          </button>
        </div>
      )}

      {yaslandirma && (
        <div style={{ marginTop: 22, maxWidth: 520 }}>
          <YaslandirmaKarti rapor={yaslandirma} baslik="Güncel Yaşlandırma" />
        </div>
      )}
    </div>
  );
}
