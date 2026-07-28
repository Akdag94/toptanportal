'use client';

/**
 * e-Fatura / e-İrsaliye Arşivi
 *
 * Muhasebecinin bu ekranda iki isi vardir: belge bulmak ve donem toplamini
 * gormek. Once ozet, sonra liste gosterilir - liste sayfalanir ve sayfalanan
 * bir listenin toplami mutabakat icin kullanilamaz.
 *
 * INDIRME iki adimlidir: sunucudan kisa omurlu imzali baglanti alinir, sonra
 * tarayici o baglantiya gider. Baglantiyi dogrudan `<a href>` yapmak Authorization
 * basligini tasiyamaz; jetonu adrese koymak ise onu tarayici gecmisine ve
 * varsa ara sunucu gunluklerine yazar.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  EDOCUMENT_KIND_LABELS,
  EDOCUMENT_STATUS_LABELS,
  EDocumentFormat,
  EDocumentKind,
  EDocumentStatus,
  type EDocument,
  type EDocumentSummary,
} from '@toptanportal/contracts';

import { eDocumentApi } from '../../../lib/api-client';
import { gun, para } from '../../../lib/bicim';

const DURUM_SINIF: Record<EDocumentStatus, string> = {
  [EDocumentStatus.DRAFT]: 'kritik',
  [EDocumentStatus.SENT]: 'kritik',
  [EDocumentStatus.DELIVERED]: 'var',
  [EDocumentStatus.ACCEPTED]: 'var',
  [EDocumentStatus.REJECTED]: 'yok',
  [EDocumentStatus.FAILED]: 'yok',
  [EDocumentStatus.CANCELLED]: 'yok',
};

const SAYFA_BOYU = 25;

export default function EvraklarSayfasi() {
  const [belgeler, setBelgeler] = useState<EDocument[]>([]);
  const [ozet, setOzet] = useState<EDocumentSummary | null>(null);
  const [toplamSayi, setToplamSayi] = useState(0);
  const [devamVar, setDevamVar] = useState(false);

  const [tur, setTur] = useState<EDocumentKind | ''>('');
  const [arama, setArama] = useState('');
  const [uygulananArama, setUygulananArama] = useState('');
  const [baslangic, setBaslangic] = useState('');
  const [bitis, setBitis] = useState('');
  const [uygulananDonem, setUygulananDonem] = useState<{ from: string; to: string }>({
    from: '',
    to: '',
  });

  const [yukleniyor, setYukleniyor] = useState(true);
  const [indirilen, setIndirilen] = useState<string | null>(null);
  const [hata, setHata] = useState<string | null>(null);

  const yukle = useCallback(
    async (ofset: number) => {
      setYukleniyor(true);
      setHata(null);

      try {
        const sayfa = await eDocumentApi.list({
          kind: tur || undefined,
          q: uygulananArama || undefined,
          from: uygulananDonem.from || undefined,
          to: uygulananDonem.to || undefined,
          offset: ofset,
          limit: SAYFA_BOYU,
        });

        setToplamSayi(sayfa.totalCount);
        setDevamVar(sayfa.hasMore);
        setBelgeler((oncekiler) =>
          ofset === 0 ? sayfa.documents : [...oncekiler, ...sayfa.documents],
        );
      } catch (error) {
        setHata(error instanceof Error ? error.message : 'Belgeler yüklenemedi.');
      } finally {
        setYukleniyor(false);
      }
    },
    [tur, uygulananArama, uygulananDonem],
  );

  useEffect(() => {
    void yukle(0);
  }, [yukle]);

  useEffect(() => {
    eDocumentApi
      .summary({
        from: uygulananDonem.from || undefined,
        to: uygulananDonem.to || undefined,
      })
      .then(setOzet)
      .catch(() => setOzet(null));
  }, [uygulananDonem]);

  async function indir(belge: EDocument, format: EDocumentFormat) {
    setIndirilen(`${belge.id}-${format}`);
    setHata(null);

    try {
      const baglanti = await eDocumentApi.link(belge.id, format);

      /* Yeni sekmede acilir: aynı sekmede gitmek, kullanicinin listedeki
         yerini kaybetmesine yol acar ve indirme bittiginde geri donecegi bir
         sayfa kalmaz. */
      window.open(baglanti.url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Belge indirilemedi.');
    } finally {
      setIndirilen(null);
    }
  }

  return (
    <div>
      <div className="sayfa-baslik">
        <div>
          <h2>e-Fatura / e-İrsaliye Arşivi</h2>
          <p>
            Belgeleriniz yasal saklama süresi boyunca (10 yıl) burada erişilebilir kalır.
            Hukuki asıl XML dosyasıdır; PDF görüntüleme kopyasıdır.
          </p>
        </div>
      </div>

      {hata && <div className="uyari-kutu hata">{hata}</div>}

      {ozet && (
        <>
          {ozet.problemCount > 0 && (
            <div className="uyari-kutu dikkat">
              Bu dönemde <strong>{ozet.problemCount} belge</strong> reddedilmiş veya hatalı
              durumda. Reddedilen fatura tahsil edilemez; düzeltme iade faturasıyla yapılır.
            </div>
          )}

          <div className="olcum-izgara">
            <article className="olcum">
              <p className="olcum-etiket">Dönem Toplamı</p>
              <p className="olcum-deger">{para(ozet.totalAmount, ozet.currency) ?? '—'}</p>
              <p className="olcum-alt">
                {gun(ozet.from)} – {gun(ozet.to)} · {ozet.totalCount} belge
              </p>
            </article>

            {ozet.byKind.map((satir) => (
              <article className="olcum" key={satir.kind}>
                <p className="olcum-etiket">{satir.kindLabel}</p>
                <p className="olcum-deger">{para(satir.totalAmount, ozet.currency) ?? '—'}</p>
                <p className="olcum-alt">{satir.count} belge</p>
              </article>
            ))}
          </div>
        </>
      )}

      <form
        className="arac-cubugu"
        onSubmit={(olay) => {
          olay.preventDefault();
          setUygulananArama(arama.trim());
          setUygulananDonem({ from: baslangic, to: bitis });
        }}
      >
        <input
          className="alan-girdi"
          style={{ maxWidth: 260 }}
          value={arama}
          onChange={(olay) => setArama(olay.target.value)}
          placeholder="Belge numarası veya ETTN"
          autoComplete="off"
        />

        <select
          className="secim"
          value={tur}
          onChange={(olay) => setTur(olay.target.value as EDocumentKind | '')}
        >
          <option value="">Tüm belgeler</option>
          {Object.entries(EDOCUMENT_KIND_LABELS).map(([deger, etiket]) => (
            <option key={deger} value={deger}>
              {etiket}
            </option>
          ))}
        </select>

        <input
          className="alan-girdi"
          style={{ maxWidth: 170 }}
          type="date"
          value={baslangic}
          onChange={(olay) => setBaslangic(olay.target.value)}
        />
        <input
          className="alan-girdi"
          style={{ maxWidth: 170 }}
          type="date"
          value={bitis}
          onChange={(olay) => setBitis(olay.target.value)}
        />

        <button className="dugme dugme-kucuk" type="submit" disabled={yukleniyor}>
          {yukleniyor ? 'Aranıyor…' : 'Ara'}
        </button>
      </form>

      {belgeler.length === 0 && !yukleniyor ? (
        <div className="bos-durum">Bu ölçütlere uyan belge bulunmuyor.</div>
      ) : (
        <div className="liste">
          <div className="liste-satir baslik">
            <span>Belge</span>
            <span>Durum</span>
            <span>Tutar</span>
            <span style={{ textAlign: 'right' }}>İndir</span>
          </div>

          {belgeler.map((belge) => (
            <div className="liste-satir" key={belge.id}>
              <div>
                <p className="urun-ad">{belge.documentNumber}</p>
                <p className="urun-alt">
                  {belge.kindLabel} · {gun(belge.issueDate)} · {belge.companyTitle}
                  {belge.orderNumber ? (
                    <>
                      {' · '}
                      <Link href={`/panel/siparisler/${belge.orderId}`}>
                        {belge.orderNumber}
                      </Link>
                    </>
                  ) : null}
                </p>
                {belge.responseNote && (
                  <p className="urun-alt" style={{ color: 'var(--hata)' }}>
                    {belge.responseNote}
                  </p>
                )}
              </div>

              <span className={`stok ${DURUM_SINIF[belge.status]}`}>
                {EDOCUMENT_STATUS_LABELS[belge.status]}
              </span>

              <div>
                <span className="fiyat">{para(belge.grandTotal, belge.currency) ?? '—'}</span>
                <p className="urun-alt">KDV: {para(belge.vatAmount, belge.currency)}</p>
              </div>

              <div className="satir-eylem">
                <button
                  type="button"
                  className="dugme dugme-kucuk"
                  disabled={indirilen !== null}
                  onClick={() => void indir(belge, EDocumentFormat.PDF)}
                >
                  {indirilen === `${belge.id}-PDF` ? 'Hazırlanıyor…' : 'PDF'}
                </button>
                <button
                  type="button"
                  className="dugme dugme-ikincil dugme-kucuk"
                  disabled={indirilen !== null}
                  onClick={() => void indir(belge, EDocumentFormat.XML)}
                  title="Hukuki asıl belge"
                >
                  {indirilen === `${belge.id}-XML` ? 'Hazırlanıyor…' : 'XML'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {devamVar && (
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <button
            type="button"
            className="dugme dugme-ikincil dugme-kucuk"
            disabled={yukleniyor}
            onClick={() => void yukle(belgeler.length)}
          >
            {yukleniyor
              ? 'Yükleniyor…'
              : `Daha Fazla Göster (${belgeler.length} / ${toplamSayi})`}
          </button>
        </div>
      )}
    </div>
  );
}
