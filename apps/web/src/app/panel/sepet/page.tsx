'use client';

/**
 * Sepet ve Siparis Tamamlama
 *
 * IDEMPOTENCY: Siparis anahtari ilk gonderimde uretilir ve HATA DURUMUNDA
 * KORUNUR. Kullanici zayif baglantida "Siparişi Tamamla" dugmesine tekrar
 * bastiginda ayni anahtar gider; sunucu ikinci siparisi acmaz, ilkinin yanitini
 * doner. Anahtar yalnizca basarili gonderimden sonra sifirlanir.
 *
 * KOR SIPARIS MODU: Toplam kutusu yalnizca sunucu tutar gonderdiyse cizilir.
 * Tutar gormeyen kullanici siparisi yine de olusturur; siparis onaya duser.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { StockStatus, type CartView, type PlaceOrderResult } from '@toptanportal/contracts';

import { ApiError, cartApi, orderApi, templateApi } from '../../../lib/api-client';
import { miktar, para, yuzde } from '../../../lib/bicim';

export default function SepetSayfasi() {
  const [sepet, setSepet] = useState<CartView | null>(null);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [islemde, setIslemde] = useState(false);
  const [hata, setHata] = useState<string | null>(null);
  const [eksikStok, setEksikStok] = useState<string[]>([]);
  const [sonuc, setSonuc] = useState<PlaceOrderResult | null>(null);
  const [musteriNotu, setMusteriNotu] = useState('');
  const [sablonAdi, setSablonAdi] = useState('');
  const [bildirim, setBildirim] = useState<string | null>(null);

  /** Gonderim anahtari: hata halinde korunur, basaride sifirlanir. */
  const siparisAnahtari = useRef<string | null>(null);

  const yukle = useCallback(async () => {
    setYukleniyor(true);
    try {
      setSepet(await cartApi.get());
      setHata(null);
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Sepet yüklenemedi.');
    } finally {
      setYukleniyor(false);
    }
  }, []);

  useEffect(() => {
    void yukle();
  }, [yukle]);

  async function calistir(islem: () => Promise<CartView>): Promise<void> {
    setIslemde(true);
    setHata(null);
    setBildirim(null);

    try {
      setSepet(await islem());
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'İşlem tamamlanamadı.');
    } finally {
      setIslemde(false);
    }
  }

  async function siparisiTamamla(): Promise<void> {
    siparisAnahtari.current ??= crypto.randomUUID();

    setIslemde(true);
    setHata(null);
    setEksikStok([]);
    setBildirim(null);

    try {
      const cevap = await orderApi.place(
        { customerNote: musteriNotu.trim() || undefined },
        siparisAnahtari.current,
      );

      // Yalnizca basarida sifirlanir; sonraki siparis yeni anahtar alir.
      siparisAnahtari.current = null;
      setSonuc(cevap);
      setSepet(await cartApi.get());
      setMusteriNotu('');
    } catch (error) {
      if (error instanceof ApiError) {
        setHata(error.message);
        setEksikStok(error.stockShortages.map((satir) => satir.productName));
      } else {
        setHata(error instanceof Error ? error.message : 'Sipariş oluşturulamadı.');
      }
    } finally {
      setIslemde(false);
    }
  }

  async function sablonOlustur(): Promise<void> {
    const ad = sablonAdi.trim();

    if (ad.length < 2) {
      setHata('Şablon adı en az 2 karakter olmalıdır.');
      return;
    }

    setIslemde(true);
    setHata(null);

    try {
      const sablon = await templateApi.createFromCart(ad, false);
      setSablonAdi('');
      setBildirim(`"${sablon.name}" şablonu ${sablon.itemCount} kalemle kaydedildi.`);
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Şablon kaydedilemedi.');
    } finally {
      setIslemde(false);
    }
  }

  if (yukleniyor) {
    return <div className="bos-durum">Sepet yükleniyor…</div>;
  }

  if (sonuc) {
    return (
      <div>
        <div className="sayfa-baslik">
          <div>
            <h2>Siparişiniz alındı</h2>
            <p>Sipariş numarası: {sonuc.order.orderNumber}</p>
          </div>
        </div>

        <div className={`uyari-kutu ${sonuc.requiresApproval ? 'dikkat' : 'bilgi'}`}>
          {sonuc.message}
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <Link className="dugme dugme-kucuk" href={`/panel/siparisler`}>
            Siparişlerime Git
          </Link>
          <Link className="dugme dugme-ikincil dugme-kucuk" href="/panel/katalog">
            Katalogda Devam Et
          </Link>
        </div>
      </div>
    );
  }

  const bos = !sepet || sepet.lines.length === 0;

  return (
    <div>
      <div className="sayfa-baslik">
        <div>
          <h2>Sepetim</h2>
          <p>
            {bos
              ? 'Sepetiniz boş.'
              : `${sepet.lines.length} kalem${sepet.priceListName ? ` · ${sepet.priceListName}` : ''}`}
          </p>
        </div>
        {!bos && (
          <button
            type="button"
            className="dugme dugme-ikincil dugme-kucuk"
            disabled={islemde}
            onClick={() => void calistir(() => cartApi.clear())}
          >
            Sepeti Boşalt
          </button>
        )}
      </div>

      {hata && (
        <div className="uyari-kutu hata">
          <div>{hata}</div>
          {eksikStok.length > 0 && (
            <ul style={{ margin: '8px 0 0 18px', padding: 0 }}>
              {eksikStok.map((ad) => (
                <li key={ad}>{ad}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {bildirim && <div className="uyari-kutu bilgi">{bildirim}</div>}

      {sepet?.hasStockIssue && (
        <div className="uyari-kutu dikkat">
          Sepetinizde stoğu yetersiz satır var. Miktarı azaltın veya satırı çıkarın.
        </div>
      )}

      {bos ? (
        <div className="bos-durum">
          Sepetinizde ürün bulunmuyor.{' '}
          <Link href="/panel/katalog">Kataloğa göz atın.</Link>
        </div>
      ) : (
        <>
          <div className="liste">
            <div className="liste-satir baslik">
              <span>Ürün</span>
              <span>Stok</span>
              <span>{sepet.blindOrderMode ? '' : 'Tutar'}</span>
              <span style={{ textAlign: 'right' }}>Miktar</span>
            </div>

            {sepet.lines.map((satir) => {
              const tutar = para(satir.netAmount, sepet.currency);
              const birimFiyat = para(satir.unitPrice, sepet.currency);

              return (
                <div className="liste-satir" key={`${satir.productId}:${satir.unitId}`}>
                  <div>
                    <p className="urun-ad">{satir.productName}</p>
                    <p className="urun-alt">
                      {satir.productCode} · {miktar(satir.baseQuantity)} ana birim
                    </p>
                    {satir.appliedDiscounts?.map((iskonto, sira) => (
                      <span className="iskonto-etiket" key={`${iskonto.kind}-${sira}`}>
                        {iskonto.kind === 'LINE_VOLUME' ? 'Hacim' : 'Dip'} iskontosu{' '}
                        {yuzde(iskonto.ratePercent)}
                      </span>
                    ))}
                  </div>

                  <span
                    className={`stok ${
                      satir.exceedsStock || satir.stockStatus === StockStatus.OUT_OF_STOCK
                        ? 'yok'
                        : satir.stockStatus === StockStatus.CRITICAL
                          ? 'kritik'
                          : 'var'
                    }`}
                  >
                    {satir.exceedsStock ? 'Yetersiz' : 'Uygun'}
                  </span>

                  <div>
                    {tutar ? (
                      <>
                        <div className="fiyat">{tutar}</div>
                        {birimFiyat && (
                          <div className="fiyat-alt">
                            {birimFiyat} / {satir.unitCode}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="fiyat-alt">—</span>
                    )}
                  </div>

                  <div className="satir-eylem">
                    <input
                      className="miktar-girdi"
                      type="number"
                      min={0}
                      step="any"
                      defaultValue={satir.quantity}
                      aria-label={`${satir.productName} miktarı`}
                      disabled={islemde}
                      onBlur={(olay) => {
                        const yeni = Number(olay.target.value.replace(',', '.'));
                        if (!Number.isFinite(yeni) || yeni === satir.quantity) return;
                        void calistir(() =>
                          cartApi.setQuantity(satir.productId, satir.unitId, yeni),
                        );
                      }}
                    />
                    <span className="urun-alt">{satir.unitCode}</span>
                    <button
                      type="button"
                      className="dugme dugme-ikincil dugme-kucuk"
                      disabled={islemde}
                      onClick={() =>
                        void calistir(() => cartApi.removeItem(satir.productId, satir.unitId))
                      }
                    >
                      Çıkar
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div
            style={{
              display: 'flex',
              gap: 20,
              marginTop: 20,
              flexWrap: 'wrap',
              alignItems: 'flex-start',
            }}
          >
            <div style={{ flex: '1 1 320px', minWidth: 280 }}>
              <label className="alan-etiket" htmlFor="musteri-notu">
                Sipariş notu (isteğe bağlı)
              </label>
              <input
                id="musteri-notu"
                className="alan-girdi"
                type="text"
                maxLength={500}
                placeholder="Örn. sabah teslim edilsin"
                value={musteriNotu}
                onChange={(olay) => setMusteriNotu(olay.target.value)}
              />

              <div style={{ marginTop: 16 }}>
                <label className="alan-etiket" htmlFor="sablon-adi">
                  Bu sepeti rutin şablon olarak kaydet
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    id="sablon-adi"
                    className="alan-girdi"
                    type="text"
                    maxLength={120}
                    placeholder="Örn. Haftalık rutin"
                    value={sablonAdi}
                    onChange={(olay) => setSablonAdi(olay.target.value)}
                  />
                  <button
                    type="button"
                    className="dugme dugme-ikincil dugme-kucuk"
                    disabled={islemde || sablonAdi.trim().length < 2}
                    onClick={() => void sablonOlustur()}
                  >
                    Kaydet
                  </button>
                </div>
              </div>
            </div>

            <div className="toplam-kutu">
              {sepet.blindOrderMode ? (
                <p className="urun-alt" style={{ margin: '0 0 12px' }}>
                  Tutar bilgisi hesabınızda gösterilmez. Siparişiniz işletme yetkilinizin
                  onayına gönderilecektir.
                </p>
              ) : (
                <>
                  <div className="toplam-satir">
                    <span>Ara toplam</span>
                    <span>{para(sepet.grossTotal, sepet.currency)}</span>
                  </div>
                  {typeof sepet.discountTotal === 'number' && sepet.discountTotal > 0 && (
                    <div className="toplam-satir">
                      <span>İskonto</span>
                      <span>-{para(sepet.discountTotal, sepet.currency)}</span>
                    </div>
                  )}
                  <div className="toplam-satir">
                    <span>Net</span>
                    <span>{para(sepet.netTotal, sepet.currency)}</span>
                  </div>
                  <div className="toplam-satir">
                    <span>KDV</span>
                    <span>{para(sepet.vatTotal, sepet.currency)}</span>
                  </div>
                  <div className="toplam-satir genel">
                    <span>Genel Toplam</span>
                    <span>{para(sepet.grandTotal, sepet.currency)}</span>
                  </div>
                </>
              )}

              <button
                type="button"
                className="dugme"
                style={{ marginTop: 14 }}
                disabled={islemde || sepet.hasStockIssue}
                onClick={() => void siparisiTamamla()}
              >
                {islemde ? 'Gönderiliyor…' : 'Siparişi Tamamla'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
