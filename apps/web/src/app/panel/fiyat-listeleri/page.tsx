'use client';

/**
 * Fiyat Listeleri (salt okunur)
 *
 * Fiyatlar Logo'dan senkronlanır; portal onları değiştirmez. Bu ekranda
 * düzenleme düğmesi YOKTUR — fiyatı portalden değiştirmek, iki sistem arasında
 * hangisinin doğru olduğu belirsiz bir alan yaratır ve bir sonraki senkron o
 * değişikliği sessizce geri alır.
 *
 * Ekranın işi fiyatı değiştirmek değil, "bu bayi bu ürünü kaçtan alıyor"
 * sorusunu cevaplamaktır — bu soru her gün, telefonda sorulur.
 */

import { useCallback, useEffect, useState } from 'react';
import type { PriceListItemView, PriceListView } from '@toptanportal/contracts';

import { priceListApi } from '../../../lib/api-client';
import { miktar, para, tarihSaat } from '../../../lib/bicim';

export default function FiyatListeleriSayfasi() {
  const [listeler, setListeler] = useState<PriceListView[]>([]);
  const [secilen, setSecilen] = useState<PriceListView | null>(null);
  const [satirlar, setSatirlar] = useState<PriceListItemView[]>([]);
  const [toplam, setToplam] = useState(0);
  const [devamVar, setDevamVar] = useState(false);

  const [arama, setArama] = useState('');
  const [uygulananArama, setUygulananArama] = useState('');

  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState<string | null>(null);

  useEffect(() => {
    priceListApi
      .list()
      .then((sonuc) => {
        setListeler(sonuc);
        setSecilen(sonuc.find((liste) => liste.isDefault) ?? sonuc[0] ?? null);
      })
      .catch((error: unknown) =>
        setHata(error instanceof Error ? error.message : 'Fiyat listeleri yüklenemedi.'),
      )
      .finally(() => setYukleniyor(false));
  }, []);

  const satirlariYukle = useCallback(
    async (ofset: number) => {
      if (!secilen) return;

      setYukleniyor(true);
      setHata(null);

      try {
        const sayfa = await priceListApi.items({
          priceListId: secilen.id,
          q: uygulananArama || undefined,
          offset: ofset,
          limit: 50,
        });

        setToplam(sayfa.totalCount);
        setDevamVar(sayfa.hasMore);
        setSatirlar((oncekiler) => (ofset === 0 ? sayfa.items : [...oncekiler, ...sayfa.items]));
      } catch (error) {
        setHata(error instanceof Error ? error.message : 'Fiyat satırları yüklenemedi.');
      } finally {
        setYukleniyor(false);
      }
    },
    [secilen, uygulananArama],
  );

  useEffect(() => {
    void satirlariYukle(0);
  }, [satirlariYukle]);

  return (
    <div>
      <div className="sayfa-baslik">
        <div>
          <h2>Fiyat Listeleri</h2>
          <p>
            Fiyatlar Logo&apos;dan senkronlanır ve portalden değiştirilemez. Değişiklik Logo
            tarafında yapılır, bir sonraki senkronda buraya yansır.
          </p>
        </div>
      </div>

      {hata && <div className="uyari-kutu hata">{hata}</div>}

      <div className="arac-cubugu">
        {listeler.map((liste) => (
          <button
            key={liste.id}
            type="button"
            className={`dugme dugme-kucuk ${secilen?.id === liste.id ? '' : 'dugme-ikincil'}`}
            onClick={() => {
              setSecilen(liste);
              setSatirlar([]);
            }}
          >
            {liste.name}
            {liste.isDefault ? ' (varsayılan)' : ''}
          </button>
        ))}
      </div>

      {secilen && (
        <div className="olcum-izgara">
          <article className="olcum">
            <p className="olcum-etiket">Liste</p>
            <p className="olcum-deger" style={{ fontSize: 19 }}>
              {secilen.name}
            </p>
            <p className="olcum-alt">
              Logo no: {secilen.logoPriceListNo} · {secilen.currency}
              {secilen.vatIncluded ? ' · KDV dahil' : ' · KDV hariç'}
            </p>
          </article>

          <article className="olcum">
            <p className="olcum-etiket">Ürün Satırı</p>
            <p className="olcum-deger">{secilen.itemCount}</p>
          </article>

          <article className="olcum">
            <p className="olcum-etiket">Bağlı Bayi</p>
            <p className="olcum-deger">{secilen.companyCount}</p>
            <p className="olcum-alt">Bu listeden fiyat alan bayi sayısı</p>
          </article>

          <article className="olcum">
            <p className="olcum-etiket">Son Senkron</p>
            <p className="olcum-deger" style={{ fontSize: 17 }}>
              {secilen.lastSyncedAt ? tarihSaat(secilen.lastSyncedAt) : 'Hiç'}
            </p>
            <p className="olcum-alt">{secilen.isActive ? 'Etkin liste' : 'Pasif liste'}</p>
          </article>
        </div>
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
        <button className="dugme dugme-kucuk" type="submit" disabled={yukleniyor}>
          {yukleniyor ? 'Aranıyor…' : 'Ara'}
        </button>
      </form>

      {satirlar.length === 0 && !yukleniyor ? (
        <div className="bos-durum">Bu listede satır bulunmuyor.</div>
      ) : (
        <div className="liste">
          <div className="liste-satir baslik">
            <span>Ürün</span>
            <span>Birim</span>
            <span>Fiyat</span>
            <span style={{ textAlign: 'right' }}>Geçerlilik</span>
          </div>

          {satirlar.map((satir) => (
            <div className="liste-satir" key={satir.id}>
              <div>
                <p className="urun-ad">{satir.productName}</p>
                <p className="urun-alt">{satir.productCode}</p>
              </div>

              <span className="urun-alt">
                {satir.unitCode ?? 'Ana birim'}
                {satir.minQuantity > 0 ? ` · min ${miktar(satir.minQuantity)}` : ''}
              </span>

              <span className="fiyat">{para(satir.price, secilen?.currency ?? 'TRY')}</span>

              <span className="urun-alt" style={{ textAlign: 'right' }}>
                {satir.validFrom || satir.validTo
                  ? `${satir.validFrom ? tarihSaat(satir.validFrom) : '—'} → ${
                      satir.validTo ? tarihSaat(satir.validTo) : 'süresiz'
                    }`
                  : 'Süresiz'}
              </span>
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
            onClick={() => void satirlariYukle(satirlar.length)}
          >
            {yukleniyor ? 'Yükleniyor…' : `Daha Fazla Göster (${satirlar.length} / ${toplam})`}
          </button>
        </div>
      )}
    </div>
  );
}
