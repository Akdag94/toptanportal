'use client';

/**
 * Urun Katalogu
 *
 * KOR SIPARIS MODU: Fiyat sutunu, kullanicinin yetkisine gore GIZLENMEZ -
 * sunucu o alani zaten hic gondermez. Arayuz `typeof urun.price === 'number'`
 * kontrolu yapar; `?? 0` gibi bir varsayilan ATAMAZ. Sifir fiyat gostermek,
 * gizlenmis fiyati gercek bir bedel gibi sunmak olurdu.
 *
 * Tukenmis urunun sepete eklenmesi engellenir; nihai karar yine sunucudadir
 * (stok siparis aninda satir kilidi altinda tekrar dogrulanir).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { StockStatus, type CatalogProduct } from '@toptanportal/contracts';

import { ApiError, cartApi, catalogApi } from '../../../lib/api-client';
import { para } from '../../../lib/bicim';

const ARAMA_GECIKMESI_MS = 300;

const STOK_SINIF: Record<StockStatus, string> = {
  [StockStatus.IN_STOCK]: 'var',
  [StockStatus.CRITICAL]: 'kritik',
  [StockStatus.OUT_OF_STOCK]: 'yok',
};

const STOK_METIN: Record<StockStatus, string> = {
  [StockStatus.IN_STOCK]: 'Stokta',
  [StockStatus.CRITICAL]: 'Kritik stok',
  [StockStatus.OUT_OF_STOCK]: 'Tükendi',
};

interface SatirDurumu {
  unitId: string;
  miktar: string;
}

export default function KatalogSayfasi() {
  const [urunler, setUrunler] = useState<CatalogProduct[]>([]);
  const [sonrakiImlec, setSonrakiImlec] = useState<string | null>(null);
  const [korMod, setKorMod] = useState(false);
  const [arama, setArama] = useState('');
  const [yalnizStokta, setYalnizStokta] = useState(false);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState<string | null>(null);
  const [bildirim, setBildirim] = useState<string | null>(null);
  const [satirlar, setSatirlar] = useState<Record<string, SatirDurumu>>({});
  const [eklenen, setEklenen] = useState<string | null>(null);

  // Yalnizca en son aramanin sonucu yazilir; yavas donen eski istek yeni
  // sonucun uzerine yazamaz.
  const istekSayaci = useRef(0);

  const yukle = useCallback(
    async (imlec?: string) => {
      const istekNo = ++istekSayaci.current;
      setYukleniyor(true);
      setHata(null);

      try {
        const sayfa = await catalogApi.list({
          q: arama.trim() || undefined,
          inStockOnly: yalnizStokta || undefined,
          cursor: imlec,
          limit: 30,
        });

        if (istekNo !== istekSayaci.current) return;

        setKorMod(sayfa.blindOrderMode);
        setSonrakiImlec(sayfa.nextCursor);
        setUrunler((oncekiler) => (imlec ? [...oncekiler, ...sayfa.items] : sayfa.items));
      } catch (error) {
        if (istekNo !== istekSayaci.current) return;
        setHata(error instanceof Error ? error.message : 'Katalog yüklenemedi.');
      } finally {
        if (istekNo === istekSayaci.current) setYukleniyor(false);
      }
    },
    [arama, yalnizStokta],
  );

  useEffect(() => {
    const zamanlayici = setTimeout(() => void yukle(), ARAMA_GECIKMESI_MS);
    return () => clearTimeout(zamanlayici);
  }, [yukle]);

  function satirDurumu(urun: CatalogProduct): SatirDurumu {
    const mevcut = satirlar[urun.id];
    if (mevcut) return mevcut;

    const varsayilan = urun.units.find((birim) => birim.isDefaultForOrder) ?? urun.units[0];
    return { unitId: varsayilan?.id ?? '', miktar: '1' };
  }

  function satiriGuncelle(urunId: string, degisiklik: Partial<SatirDurumu>): void {
    setSatirlar((oncekiler) => {
      const urun = urunler.find((u) => u.id === urunId);
      const temel = urun ? satirDurumu(urun) : { unitId: '', miktar: '1' };
      return { ...oncekiler, [urunId]: { ...temel, ...degisiklik } };
    });
  }

  async function sepeteEkle(urun: CatalogProduct): Promise<void> {
    const durum = satirDurumu(urun);
    const adet = Number(durum.miktar.replace(',', '.'));

    if (!Number.isFinite(adet) || adet <= 0) {
      setHata('Geçerli bir miktar girin.');
      return;
    }

    setEklenen(urun.id);
    setHata(null);
    setBildirim(null);

    try {
      await cartApi.addItem({ productId: urun.id, unitId: durum.unitId, quantity: adet });
      const birim = urun.units.find((b) => b.id === durum.unitId);
      setBildirim(`${urun.name} sepete eklendi (${adet} ${birim?.code ?? ''}).`);
    } catch (error) {
      setHata(
        error instanceof ApiError ? error.message : 'Ürün sepete eklenemedi. Tekrar deneyin.',
      );
    } finally {
      setEklenen(null);
    }
  }

  return (
    <div>
      <div className="sayfa-baslik">
        <div>
          <h2>Ürün Kataloğu</h2>
          <p>
            {korMod
              ? 'Fiyat bilgisi hesabınızda gösterilmez. Siparişiniz işletme yetkilinizin onayına gönderilir.'
              : 'Fiyatlar işletmenize tanımlı listeye göre, vergi hariç gösterilir.'}
          </p>
        </div>
      </div>

      <div className="arac-cubugu">
        <input
          className="alan-girdi"
          type="search"
          placeholder="Ürün adı, kodu veya barkod"
          value={arama}
          onChange={(olay) => setArama(olay.target.value)}
          aria-label="Katalogda ara"
        />
        <label className="onay-etiket">
          <input
            type="checkbox"
            checked={yalnizStokta}
            onChange={(olay) => setYalnizStokta(olay.target.checked)}
          />
          Yalnızca stokta olanlar
        </label>
      </div>

      {hata && <div className="uyari-kutu hata">{hata}</div>}
      {bildirim && <div className="uyari-kutu bilgi">{bildirim}</div>}

      {urunler.length === 0 && !yukleniyor ? (
        <div className="bos-durum">
          {arama.trim()
            ? `"${arama.trim()}" için ürün bulunamadı.`
            : 'Katalogda yayınlanmış ürün bulunmuyor.'}
        </div>
      ) : (
        <div className="liste">
          <div className="liste-satir baslik">
            <span>Ürün</span>
            <span>Stok</span>
            <span>{korMod ? '' : 'Birim Fiyat'}</span>
            <span style={{ textAlign: 'right' }}>Sipariş</span>
          </div>

          {urunler.map((urun) => {
            const durum = satirDurumu(urun);
            const secili = urun.units.find((birim) => birim.id === durum.unitId);
            const tukendi = urun.stockStatus === StockStatus.OUT_OF_STOCK;
            const birimFiyat = para(secili?.unitPrice);

            return (
              <div className="liste-satir" key={urun.id}>
                <div>
                  <p className="urun-ad">{urun.name}</p>
                  <p className="urun-alt">
                    {urun.code}
                    {urun.brand ? ` · ${urun.brand}` : ''}
                  </p>
                </div>

                <span className={`stok ${STOK_SINIF[urun.stockStatus]}`}>
                  {STOK_METIN[urun.stockStatus]}
                </span>

                <div>
                  {birimFiyat ? (
                    <>
                      <div className="fiyat">{birimFiyat}</div>
                      <div className="fiyat-alt">
                        / {secili?.code}
                        {typeof urun.vatRate === 'number' ? ` · KDV %${urun.vatRate}` : ''}
                      </div>
                    </>
                  ) : (
                    <span className="fiyat-alt">—</span>
                  )}
                </div>

                <div className="satir-eylem">
                  <select
                    className="secim"
                    value={durum.unitId}
                    aria-label={`${urun.name} birimi`}
                    onChange={(olay) => satiriGuncelle(urun.id, { unitId: olay.target.value })}
                  >
                    {urun.units.map((birim) => (
                      <option key={birim.id} value={birim.id}>
                        {birim.name}
                      </option>
                    ))}
                  </select>

                  <input
                    className="miktar-girdi"
                    type="number"
                    min={0}
                    step="any"
                    value={durum.miktar}
                    aria-label={`${urun.name} miktarı`}
                    onChange={(olay) => satiriGuncelle(urun.id, { miktar: olay.target.value })}
                  />

                  <button
                    type="button"
                    className="dugme dugme-kucuk"
                    disabled={tukendi || eklenen === urun.id}
                    title={tukendi ? 'Bu ürün şu anda tükenmiştir.' : undefined}
                    onClick={() => void sepeteEkle(urun)}
                  >
                    {eklenen === urun.id ? 'Ekleniyor…' : 'Sepete Ekle'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {sonrakiImlec && (
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <button
            type="button"
            className="dugme dugme-ikincil dugme-kucuk"
            disabled={yukleniyor}
            onClick={() => void yukle(sonrakiImlec)}
          >
            {yukleniyor ? 'Yükleniyor…' : 'Daha Fazla Göster'}
          </button>
        </div>
      )}
    </div>
  );
}
