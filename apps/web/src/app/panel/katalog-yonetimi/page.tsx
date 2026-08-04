'use client';

/**
 * Katalog Yönetimi (portal → Logo)
 *
 * Ürün kataloğunu OKUYAN ekrandan (`/panel/katalog`) ayrıdır: burada açılan her
 * kart Logo'da kalıcı bir stok kartı doğurur ve kartın kodu sonradan
 * değiştirilemez.
 *
 * Ekranın taşıdığı iki bilgi, formun kendisinden önemlidir:
 *
 *   1. KÖKEN. Logo'da açılmış bir kartın adı ve KDV oranı portalden
 *      değiştirilemez; alanlar bu yüzden kilitli gelir. Kilidi gerekçesiyle
 *      birlikte göstermek, kullanıcıyı "neden yazamıyorum" diye denemeye
 *      devam etmekten kurtarır.
 *   2. YAZIM DURUMU. Kart portale kaydedildiğinde iş bitmez; Logo'ya yazılması
 *      gerekir. "Logo'ya yazılıyor" işareti kalkmadan ürün muhasebede yoktur.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  LOGO_WRITE_STATE_LABELS,
  PRODUCT_ORIGIN_LABELS,
  type AdminProductView,
  type LogoWriteState,
  type ProductUnitInput,
} from '@toptanportal/contracts';

import { catalogAdminApi } from '../../../lib/api-client';
import { tarihSaat } from '../../../lib/bicim';

const KDV_ORANLARI = [0, 1, 10, 20] as const;

const BOS_BIRIMLER: ProductUnitInput[] = [
  { code: 'ADET', name: 'Adet', conversionFactor: 1, isBaseUnit: true, isDefaultForOrder: false },
  { code: 'KOLI', name: 'Koli', conversionFactor: 12, isBaseUnit: false, isDefaultForOrder: true },
];

function DurumRozeti({ urun }: { urun: AdminProductView }) {
  if (urun.logoWriteState === 'SYNCED') return null;

  return (
    <span
      className={`rozet ${
        urun.logoWriteState === 'PENDING' ? 'yazim-bekliyor' : 'yazim-reddedildi'
      }`}
      title={urun.logoWriteError ?? undefined}
    >
      {LOGO_WRITE_STATE_LABELS[urun.logoWriteState]}
    </span>
  );
}

export default function KatalogYonetimiSayfasi() {
  const [urunler, setUrunler] = useState<AdminProductView[]>([]);
  const [toplam, setToplam] = useState(0);
  const [devamVar, setDevamVar] = useState(false);

  const [arama, setArama] = useState('');
  const [uygulananArama, setUygulananArama] = useState('');
  const [durumSuzgeci, setDurumSuzgeci] = useState<LogoWriteState | ''>('');

  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState<string | null>(null);
  const [bilgi, setBilgi] = useState<string | null>(null);

  const [formAcik, setFormAcik] = useState(false);
  const [kaydediliyor, setKaydediliyor] = useState(false);
  const [kod, setKod] = useState('');
  const [ad, setAd] = useState('');
  const [marka, setMarka] = useState('');
  const [kategori, setKategori] = useState('');
  const [kdv, setKdv] = useState<(typeof KDV_ORANLARI)[number]>(20);

  const yukle = useCallback(
    async (ofset: number) => {
      setYukleniyor(true);
      setHata(null);

      try {
        const sayfa = await catalogAdminApi.list({
          q: uygulananArama || undefined,
          writeState: durumSuzgeci || undefined,
          offset: ofset,
          limit: 50,
        });

        setToplam(sayfa.totalCount);
        setDevamVar(sayfa.hasMore);
        setUrunler((oncekiler) => (ofset === 0 ? sayfa.items : [...oncekiler, ...sayfa.items]));
      } catch (error) {
        setHata(error instanceof Error ? error.message : 'Ürünler yüklenemedi.');
      } finally {
        setYukleniyor(false);
      }
    },
    [uygulananArama, durumSuzgeci],
  );

  useEffect(() => {
    void yukle(0);
  }, [yukle]);

  const kartAc = async () => {
    setKaydediliyor(true);
    setHata(null);
    setBilgi(null);

    try {
      const olusan = await catalogAdminApi.create({
        logoItemCode: kod.trim().toUpperCase(),
        name: ad.trim(),
        brand: marka.trim() || null,
        categoryPath: kategori.trim() || null,
        vatRate: kdv,
        units: BOS_BIRIMLER,
        criticalStockThreshold: 0,
        minOrderQuantity: 0,
        sortOrder: 0,
        /* Kart TASLAK açılır. Yayına alma, Logo yazımı tamamlandıktan sonra
           yapılır: fiyatı ve stoğu henüz gelmemiş bir ürünü satışa açmak,
           sipariş edilip karşılanamayacak bir ürün göstermektir. */
        publishImmediately: false,
      });

      setUrunler((oncekiler) => [olusan, ...oncekiler]);
      setFormAcik(false);
      setKod('');
      setAd('');
      setMarka('');
      setKategori('');
      setBilgi(
        `${olusan.logoItemCode} kartı açıldı ve Logo'ya yazılmak üzere kuyruğa alındı. ` +
          'Yazım tamamlandığında durum işareti kalkar.',
      );
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Ürün kartı açılamadı.');
    } finally {
      setKaydediliyor(false);
    }
  };

  const yayinDurumunuDegistir = async (urun: AdminProductView) => {
    try {
      const guncel = await catalogAdminApi.update(urun.id, {
        status: urun.status === 'PUBLISHED' ? 'DRAFT' : 'PUBLISHED',
      });

      setUrunler((oncekiler) => oncekiler.map((s) => (s.id === guncel.id ? guncel : s)));
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Ürün durumu değiştirilemedi.');
    }
  };

  return (
    <div>
      <div className="sayfa-baslik">
        <div>
          <h2>Katalog Yönetimi</h2>
          <p>
            Burada açılan ürün Logo&apos;da gerçek bir stok kartı doğurur ve{' '}
            <strong>stok kodu sonradan değiştirilemez</strong>. Kart taslak açılır; Logo&apos;ya
            yazıldıktan sonra yayına alınır.
          </p>
        </div>

        <button
          type="button"
          className="dugme"
          onClick={() => {
            setFormAcik((acik) => !acik);
            setBilgi(null);
          }}
        >
          {formAcik ? 'Vazgeç' : 'Yeni Ürün'}
        </button>
      </div>

      {hata && <div className="uyari-kutu hata">{hata}</div>}
      {bilgi && <div className="uyari-kutu">{bilgi}</div>}

      {formAcik && (
        <section className="kart" style={{ marginBottom: 18 }}>
          <div className="kart-izgara">
            <label className="alan">
              <span className="alan-etiket">Stok Kodu</span>
              <input
                className="alan-girdi"
                value={kod}
                onChange={(olay) => setKod(olay.target.value.toUpperCase())}
                placeholder="KHV-250"
                autoComplete="off"
              />
              <span className="urun-alt">
                Büyük harf, rakam ve <code>. - _</code>. Sonradan değiştirilemez.
              </span>
            </label>

            <label className="alan">
              <span className="alan-etiket">Ürün Adı</span>
              <input
                className="alan-girdi"
                value={ad}
                onChange={(olay) => setAd(olay.target.value)}
                placeholder="Filtre Kahve 250 g"
              />
            </label>

            <label className="alan">
              <span className="alan-etiket">Marka</span>
              <input
                className="alan-girdi"
                value={marka}
                onChange={(olay) => setMarka(olay.target.value)}
              />
            </label>

            <label className="alan">
              <span className="alan-etiket">Kategori</span>
              <input
                className="alan-girdi"
                value={kategori}
                onChange={(olay) => setKategori(olay.target.value)}
                placeholder="İçecek / Kahve"
              />
            </label>

            <label className="alan">
              <span className="alan-etiket">KDV Oranı</span>
              <select
                className="alan-girdi"
                value={kdv}
                onChange={(olay) =>
                  setKdv(Number(olay.target.value) as (typeof KDV_ORANLARI)[number])
                }
              >
                {KDV_ORANLARI.map((oran) => (
                  <option key={oran} value={oran}>
                    %{oran}
                  </option>
                ))}
              </select>
              <span className="urun-alt">
                Yalnızca yürürlükteki oranlar. Serbest giriş, yanlış oranın faturaya kadar fark
                edilmemesine yol açar.
              </span>
            </label>
          </div>

          <div className="arac-cubugu" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="dugme"
              disabled={kaydediliyor || kod.trim().length < 2 || ad.trim().length < 2}
              onClick={() => void kartAc()}
            >
              {kaydediliyor ? 'Açılıyor…' : 'Kartı Aç ve Logo’ya Gönder'}
            </button>
          </div>
        </section>
      )}

      <form
        className="arac-cubugu"
        onSubmit={(olay) => {
          olay.preventDefault();
          setUygulananArama(arama.trim());
        }}
      >
        <input
          className="alan-girdi"
          style={{ maxWidth: 280 }}
          value={arama}
          onChange={(olay) => setArama(olay.target.value)}
          placeholder="Ürün adı veya stok kodu"
          autoComplete="off"
        />

        <select
          className="alan-girdi"
          style={{ maxWidth: 220 }}
          value={durumSuzgeci}
          onChange={(olay) => {
            setDurumSuzgeci(olay.target.value as LogoWriteState | '');
            setUrunler([]);
          }}
          aria-label="Logo yazma durumu"
        >
          <option value="">Tüm kartlar</option>
          <option value="PENDING">Logo&apos;ya yazılıyor</option>
          {/* Operatörün ilk baktığı liste budur. */}
          <option value="FAILED">Logo reddetti</option>
        </select>

        <button className="dugme dugme-kucuk" type="submit" disabled={yukleniyor}>
          {yukleniyor ? 'Aranıyor…' : 'Ara'}
        </button>
      </form>

      {urunler.length === 0 && !yukleniyor ? (
        <div className="bos-durum">Kayıt bulunamadı.</div>
      ) : (
        <div className="liste">
          <div className="liste-satir baslik">
            <span>Ürün</span>
            <span>Köken</span>
            <span>Durum</span>
            <span style={{ textAlign: 'right' }}>İşlem</span>
          </div>

          {urunler.map((urun) => (
            <div className="liste-satir" key={urun.id}>
              <div>
                <p className="urun-ad">{urun.name}</p>
                <p className="urun-alt">
                  {urun.logoItemCode} · KDV %{urun.vatRate}
                  {urun.categoryPath ? ` · ${urun.categoryPath}` : ''}
                </p>
              </div>

              <div>
                <span className="rozet koken">{PRODUCT_ORIGIN_LABELS[urun.origin]}</span>
                {urun.editableIdentityFields.length === 0 && (
                  <p className="urun-alt" style={{ marginTop: 4 }}>
                    Adı ve KDV oranı Logo&apos;da yönetilir
                  </p>
                )}
              </div>

              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <span className="urun-alt">
                  {urun.status === 'PUBLISHED'
                    ? 'Yayında'
                    : urun.status === 'DRAFT'
                      ? 'Taslak'
                      : 'Arşiv'}
                </span>
                <DurumRozeti urun={urun} />
              </div>

              <div style={{ textAlign: 'right' }}>
                <button
                  type="button"
                  className="dugme dugme-ikincil dugme-kucuk"
                  /* Logo'da karşılığı olmayan kart yayına alınamaz: bayinin
                     sipariş verebileceği ama Logo'ya asla düşemeyecek bir ürün
                     göstermek olurdu. */
                  disabled={
                    urun.status === 'ARCHIVED' ||
                    (urun.status !== 'PUBLISHED' &&
                      urun.origin === 'PORTAL' &&
                      urun.logoWriteState !== 'SYNCED')
                  }
                  onClick={() => void yayinDurumunuDegistir(urun)}
                >
                  {urun.status === 'PUBLISHED' ? 'Taslağa Al' : 'Yayına Al'}
                </button>
                <p className="urun-alt" style={{ marginTop: 4 }}>
                  {urun.lastSyncedAt ? tarihSaat(urun.lastSyncedAt) : 'Logo’ya hiç yazılmadı'}
                </p>
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
            onClick={() => void yukle(urunler.length)}
          >
            {yukleniyor ? 'Yükleniyor…' : `Daha Fazla Göster (${urunler.length} / ${toplam})`}
          </button>
        </div>
      )}
    </div>
  );
}
