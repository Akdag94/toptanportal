'use client';

/**
 * Fiyat Listeleri
 *
 * Ekranın ilk işi hâlâ "bu bayi bu ürünü kaçtan alıyor" sorusunu cevaplamaktır
 * — o soru her gün, telefonda sorulur. İkinci işi fiyatı değiştirmektir ve
 * değişiklik Logo'ya yazılır.
 *
 * Eski gerekçe ("portalden değiştirilen fiyatı senkron geri alır") doğruydu;
 * çözüm fiyatı portalde tutmak değil, değişikliği Logo'ya TAŞIMAKTIR. Bu
 * yüzden ekranda tek bir şey daha var: yazımın Logo'ya ulaşıp ulaşmadığını
 * gösteren rozet. O rozet olmadan kullanıcı yeni fiyatı görür ve işinin
 * bittiğini sanır.
 *
 * Toplu düzenleme YOKTUR. Bir ekrandan yüzlerce fiyatı birden değiştirmek,
 * yanlış bir yüzdeyi tüm katalogda uygulamayı bir tıklık hale getirir.
 */

import { useCallback, useEffect, useState } from 'react';
import { LOGO_WRITE_STATE_LABELS } from '@toptanportal/contracts';
import type { PriceListItemView, PriceListView } from '@toptanportal/contracts';

import { priceListApi } from '../../../lib/api-client';
import { miktar, para, tarihSaat } from '../../../lib/bicim';
import { useSession } from '../../../lib/session-context';

/**
 * Yazim durumu rozeti.
 *
 * `SYNCED` icin hicbir sey cizilmez: "her sey yolunda" bilgisi her satirda
 * tekrarlandiginda gorsel gurultu olur ve asil bakilmasi gereken iki durum
 * arasinda kaybolur.
 */
function YazimRozeti({ satir }: { satir: PriceListItemView }) {
  if (satir.logoWriteState === 'SYNCED') return null;

  return (
    <span
      className={`rozet ${
        satir.logoWriteState === 'PENDING' ? 'yazim-bekliyor' : 'yazim-reddedildi'
      }`}
      title={satir.logoWriteError ?? undefined}
    >
      {LOGO_WRITE_STATE_LABELS[satir.logoWriteState]}
    </span>
  );
}

export default function FiyatListeleriSayfasi() {
  const { user } = useSession();
  const fiyatDegistirebilir = (user?.permissions ?? []).includes('price:change');

  const [listeler, setListeler] = useState<PriceListView[]>([]);
  const [secilen, setSecilen] = useState<PriceListView | null>(null);
  const [satirlar, setSatirlar] = useState<PriceListItemView[]>([]);
  const [toplam, setToplam] = useState(0);
  const [devamVar, setDevamVar] = useState(false);

  const [arama, setArama] = useState('');
  const [uygulananArama, setUygulananArama] = useState('');

  /** Duzenlenen satirin kimligi. Ayni anda tek satir duzenlenir. */
  const [duzenlenen, setDuzenlenen] = useState<PriceListItemView | null>(null);
  const [yeniFiyat, setYeniFiyat] = useState('');
  const [gerekce, setGerekce] = useState('');
  const [kaydediliyor, setKaydediliyor] = useState(false);

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

  const duzenlemeyiBaslat = (satir: PriceListItemView) => {
    setDuzenlenen(satir);
    /* Alan MEVCUT fiyatla dolu gelir. Bos bir alan, kullanicinin eski fiyati
       hatirlamasini ya da satiri kapatip yeniden bakmasini gerektirir. */
    setYeniFiyat(String(satir.price));
    setGerekce('');
    setHata(null);
  };

  const fiyatiKaydet = async () => {
    if (!duzenlenen || !secilen) return;

    const deger = Number(yeniFiyat.replace(',', '.'));

    if (!Number.isFinite(deger) || deger < 0) {
      setHata('Geçerli bir fiyat giriniz.');
      return;
    }

    setKaydediliyor(true);
    setHata(null);

    try {
      const guncel = await priceListApi.change({
        priceListId: secilen.id,
        productId: duzenlenen.productId,
        unitId: duzenlenen.unitId,
        minQuantity: duzenlenen.minQuantity,
        price: deger,
        reason: gerekce.trim(),
      });

      /* Satir YERINDE guncellenir, liste bastan cekilmez: kullanicinin
         kaydirdigi yer korunur ve degisen satirin yeni durumu (Logo'ya
         yazılıyor) hemen gorunur. */
      setSatirlar((oncekiler) =>
        oncekiler.map((satir) => (satir.id === guncel.id ? guncel : satir)),
      );
      setDuzenlenen(null);
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Fiyat değiştirilemedi.');
    } finally {
      setKaydediliyor(false);
    }
  };

  return (
    <div>
      <div className="sayfa-baslik">
        <div>
          <h2>Fiyat Listeleri</h2>
          <p>
            {fiyatDegistirebilir
              ? 'Buradan değiştirilen fiyat Logo’ya yazılır. Yazım tamamlanana kadar satır “Logo’ya yazılıyor” işaretlidir — o işaret kalkmadan değişiklik muhasebede geçerli değildir.'
              : 'Fiyatlar Logo ile eşleşir. Değiştirme yetkisi yalnızca yöneticidedir.'}
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
            <span style={{ textAlign: 'right' }}>
              {fiyatDegistirebilir ? 'Durum' : 'Geçerlilik'}
            </span>
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

              {duzenlenen?.id === satir.id ? (
                <div style={{ display: 'grid', gap: 6 }}>
                  <input
                    className="alan-girdi"
                    style={{ maxWidth: 140 }}
                    value={yeniFiyat}
                    onChange={(olay) => setYeniFiyat(olay.target.value)}
                    inputMode="decimal"
                    autoFocus
                    aria-label="Yeni fiyat"
                  />
                  <input
                    className="alan-girdi"
                    style={{ maxWidth: 260 }}
                    value={gerekce}
                    onChange={(olay) => setGerekce(olay.target.value)}
                    placeholder="Değişiklik gerekçesi (zorunlu)"
                    aria-label="Değişiklik gerekçesi"
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      className="dugme dugme-kucuk"
                      disabled={kaydediliyor || gerekce.trim().length < 3}
                      onClick={() => void fiyatiKaydet()}
                    >
                      {kaydediliyor ? 'Kaydediliyor…' : 'Kaydet ve Logo’ya Yaz'}
                    </button>
                    <button
                      type="button"
                      className="dugme dugme-ikincil dugme-kucuk"
                      disabled={kaydediliyor}
                      onClick={() => setDuzenlenen(null)}
                    >
                      Vazgeç
                    </button>
                  </div>
                </div>
              ) : (
                <span className="fiyat">{para(satir.price, secilen?.currency ?? 'TRY')}</span>
              )}

              <div
                style={{
                  textAlign: 'right',
                  display: 'flex',
                  gap: 8,
                  justifyContent: 'flex-end',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                }}
              >
                <YazimRozeti satir={satir} />

                {!fiyatDegistirebilir && (
                  <span className="urun-alt">
                    {satir.validFrom || satir.validTo
                      ? `${satir.validFrom ? tarihSaat(satir.validFrom) : '—'} → ${
                          satir.validTo ? tarihSaat(satir.validTo) : 'süresiz'
                        }`
                      : 'Süresiz'}
                  </span>
                )}

                {fiyatDegistirebilir && duzenlenen?.id !== satir.id && (
                  <button
                    type="button"
                    className="dugme dugme-ikincil dugme-kucuk"
                    onClick={() => duzenlemeyiBaslat(satir)}
                  >
                    Değiştir
                  </button>
                )}
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
            onClick={() => void satirlariYukle(satirlar.length)}
          >
            {yukleniyor ? 'Yükleniyor…' : `Daha Fazla Göster (${satirlar.length} / ${toplam})`}
          </button>
        </div>
      )}
    </div>
  );
}
