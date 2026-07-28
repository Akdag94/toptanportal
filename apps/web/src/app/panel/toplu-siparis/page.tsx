'use client';

/**
 * Toplu Sipariş (Excel)
 *
 * Bayilerin çoğu sipariş listesini hâlâ Excel'de tutar. Bu ekran o listeyi
 * kabul eder — çünkü portalin benimsenmesi, kullanıcının çalışma alışkanlığını
 * değiştirmesine bağlı olmamalıdır.
 *
 * Hem dosya SÜRÜKLEMEYİ hem doğrudan YAPIŞTIRMAYI destekler: kullanıcıların
 * çoğu Excel'den hücreleri kopyalar, dosyayı kaydetmez.
 *
 * SONUÇ RAPORU eksiksizdir: kaç satır okundu, kaçı sepete girdi, hangileri
 * eşleşmedi. "37 kalem eklendi" demek yeterli değildir — kullanıcı 40 satır
 * yüklediğini biliyor ve eksik üçünü aramak zorunda kalmamalı.
 */

import { useRef, useState } from 'react';
import Link from 'next/link';
import type { BulkImportResult } from '@toptanportal/contracts';

import { cartApi } from '../../../lib/api-client';

const ORNEK = `Stok Kodu;Adet
KHV-1000;12
SUT-UHT-1L;24
CAY-500G;6`;

export default function TopluSiparisSayfasi() {
  const [icerik, setIcerik] = useState('');
  const [uzerineYaz, setUzerineYaz] = useState(false);
  const [sonuc, setSonuc] = useState<BulkImportResult | null>(null);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [hata, setHata] = useState<string | null>(null);
  const [suruklemede, setSuruklemede] = useState(false);
  const dosyaGirdisi = useRef<HTMLInputElement>(null);

  async function dosyaOku(dosya: File) {
    /* Dosya TARAYICIDA okunur ve metin olarak gonderilir. Coklu parcali
       yukleme, hem arayuze hem sunucuya gereksiz bir katman ekler ve CSV
       zaten metindir. */
    const metin = await dosya.text();
    setIcerik(metin);
    setHata(null);
  }

  async function aktar() {
    if (icerik.trim().length === 0) {
      setHata('Önce listeyi yapıştırın veya bir dosya seçin.');
      return;
    }

    setYukleniyor(true);
    setHata(null);

    try {
      setSonuc(await cartApi.bulkImport(icerik, uzerineYaz));
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Liste aktarılamadı.');
    } finally {
      setYukleniyor(false);
    }
  }

  return (
    <div>
      <div className="sayfa-baslik">
        <div>
          <h2>Toplu Sipariş</h2>
          <p>
            Excel listenizi yapıştırın veya dosyayı sürükleyin. Beklenen biçim:{' '}
            <code>Stok Kodu;Miktar</code> — ayraç olarak noktalı virgül, virgül veya sekme
            kullanabilirsiniz.
          </p>
        </div>
      </div>

      {hata && <div className="uyari-kutu hata">{hata}</div>}

      <div
        className={`toplam-kutu${suruklemede ? ' surukleniyor' : ''}`}
        style={{ maxWidth: 720, borderStyle: suruklemede ? 'dashed' : undefined }}
        onDragOver={(olay) => {
          olay.preventDefault();
          setSuruklemede(true);
        }}
        onDragLeave={() => setSuruklemede(false)}
        onDrop={(olay) => {
          olay.preventDefault();
          setSuruklemede(false);
          const dosya = olay.dataTransfer.files[0];
          if (dosya) void dosyaOku(dosya);
        }}
      >
        <label className="alan">
          <span className="alan-etiket">Liste</span>
          <textarea
            className="alan-girdi"
            style={{ minHeight: 220, resize: 'vertical', fontFamily: 'ui-monospace, monospace' }}
            value={icerik}
            onChange={(olay) => setIcerik(olay.target.value)}
            placeholder={ORNEK}
            spellCheck={false}
          />
        </label>

        <div className="arac-cubugu" style={{ marginBottom: 12 }}>
          <button
            type="button"
            className="dugme dugme-ikincil dugme-kucuk"
            onClick={() => dosyaGirdisi.current?.click()}
          >
            Dosya Seç (.csv / .txt)
          </button>

          <input
            ref={dosyaGirdisi}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            style={{ display: 'none' }}
            onChange={(olay) => {
              const dosya = olay.target.files?.[0];
              if (dosya) void dosyaOku(dosya);
            }}
          />

          <button
            type="button"
            className="dugme dugme-ikincil dugme-kucuk"
            onClick={() => setIcerik(ORNEK)}
          >
            Örnek Doldur
          </button>
        </div>

        <label className="onay-etiket">
          <input
            type="checkbox"
            checked={uzerineYaz}
            onChange={(olay) => setUzerineYaz(olay.target.checked)}
          />
          Mevcut sepeti temizle ve yerine bu listeyi koy
        </label>

        <button className="dugme" type="button" disabled={yukleniyor} onClick={() => void aktar()}>
          {yukleniyor ? 'Aktarılıyor…' : 'Sepete Aktar'}
        </button>
      </div>

      {sonuc && (
        <div style={{ marginTop: 22 }}>
          <div className="olcum-izgara">
            <article className="olcum">
              <p className="olcum-etiket">Okunan Satır</p>
              <p className="olcum-deger">{sonuc.totalLines}</p>
            </article>

            <article className="olcum">
              <p className="olcum-etiket">Sepete Eklenen</p>
              <p className="olcum-deger alacak">{sonuc.importedCount}</p>
              <p className="olcum-alt">
                Sepette toplam {sonuc.cart.lines.length} kalem
              </p>
            </article>

            <article className="olcum">
              <p className="olcum-etiket">Eşleşmeyen</p>
              <p className={`olcum-deger ${sonuc.unmatchedCodes.length > 0 ? 'gecikmis' : ''}`}>
                {sonuc.unmatchedCodes.length}
              </p>
              <p className="olcum-alt">Portalde bulunamayan stok kodu</p>
            </article>

            <article className="olcum">
              <p className="olcum-etiket">Okunamayan</p>
              <p className={`olcum-deger ${sonuc.invalidLines.length > 0 ? 'borc' : ''}`}>
                {sonuc.invalidLines.length}
              </p>
              <p className="olcum-alt">Biçimi bozuk satır</p>
            </article>
          </div>

          {sonuc.unmatchedCodes.length > 0 && (
            <div className="uyari-kutu dikkat">
              <strong>Bu satırlar sepete eklenemedi:</strong>
              <ul style={{ margin: '8px 0 0 18px', padding: 0 }}>
                {sonuc.unmatchedCodes.map((satir) => (
                  <li key={satir}>{satir}</li>
                ))}
              </ul>
            </div>
          )}

          {sonuc.invalidLines.length > 0 && (
            <div className="uyari-kutu hata">
              <strong>Biçimi okunamayan satırlar:</strong>
              <ul style={{ margin: '8px 0 0 18px', padding: 0 }}>
                {sonuc.invalidLines.map((satir) => (
                  <li key={satir}>{satir}</li>
                ))}
              </ul>
            </div>
          )}

          <p style={{ marginTop: 16 }}>
            <Link className="dugme dugme-kucuk" href="/panel/sepet">
              Sepete Git
            </Link>
          </p>
        </div>
      )}
    </div>
  );
}
