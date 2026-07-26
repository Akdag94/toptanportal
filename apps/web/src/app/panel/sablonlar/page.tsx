'use client';

/**
 * Rutin Siparis Sablonlari
 *
 * Her hafta ayni 40 kalemi siparis eden isletme, urunleri tek tek aramak
 * zorunda kalmamalidir. Sablon sepete uygulanir, miktarlar gozden gecirilir,
 * siparis verilir.
 *
 * Uygulama sirasinda stokta olmayan satirlar SESSIZCE ATLANMAZ; atlananlar
 * gerekcesiyle listelenir. Sessiz atlama, musterinin eksik siparis verdigini
 * fark etmemesine yol acar.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  StockStatus,
  type ApplyTemplateResult,
  type OrderTemplateView,
} from '@toptanportal/contracts';

import { templateApi } from '../../../lib/api-client';
import { miktar } from '../../../lib/bicim';
import { useSession } from '../../../lib/session-context';

const ATLAMA_SEBEBI: Record<ApplyTemplateResult['skipped'][number]['reason'], string> = {
  OUT_OF_STOCK: 'stokta yok',
  UNAVAILABLE: 'satışta değil',
  UNIT_CHANGED: 'birimi değişmiş',
};

export default function SablonlarSayfasi() {
  const { user } = useSession();
  const router = useRouter();

  const [sablonlar, setSablonlar] = useState<OrderTemplateView[]>([]);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [islemdeki, setIslemdeki] = useState<string | null>(null);
  const [hata, setHata] = useState<string | null>(null);
  const [sonuc, setSonuc] = useState<ApplyTemplateResult | null>(null);
  const [acikSablon, setAcikSablon] = useState<string | null>(null);

  const yukle = useCallback(async () => {
    setYukleniyor(true);
    try {
      setSablonlar(await templateApi.list());
      setHata(null);
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Şablonlar yüklenemedi.');
    } finally {
      setYukleniyor(false);
    }
  }, []);

  useEffect(() => {
    void yukle();
  }, [yukle]);

  async function sepeteUygula(sablon: OrderTemplateView): Promise<void> {
    setIslemdeki(sablon.id);
    setHata(null);
    setSonuc(null);

    try {
      setSonuc(await templateApi.apply(sablon.id));
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Şablon sepete uygulanamadı.');
    } finally {
      setIslemdeki(null);
    }
  }

  async function sil(sablon: OrderTemplateView): Promise<void> {
    setIslemdeki(sablon.id);
    setHata(null);

    try {
      await templateApi.remove(sablon.id);
      setSablonlar((oncekiler) => oncekiler.filter((s) => s.id !== sablon.id));
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Şablon silinemedi.');
    } finally {
      setIslemdeki(null);
    }
  }

  if (yukleniyor) return <div className="bos-durum">Yükleniyor…</div>;

  return (
    <div>
      <div className="sayfa-baslik">
        <div>
          <h2>Rutin Şablonlarım</h2>
          <p>Şablonu sepete uyguladığınızda mevcut sepetiniz şablondaki kalemlerle değişir.</p>
        </div>
      </div>

      {hata && <div className="uyari-kutu hata">{hata}</div>}

      {sonuc && (
        <div className={`uyari-kutu ${sonuc.skipped.length > 0 ? 'dikkat' : 'bilgi'}`}>
          <div>
            {sonuc.addedCount} kalem sepete aktarıldı.
            {sonuc.skipped.length > 0 && ' Aşağıdaki kalemler aktarılamadı:'}
          </div>
          {sonuc.skipped.length > 0 && (
            <ul style={{ margin: '8px 0 0 18px', padding: 0 }}>
              {sonuc.skipped.map((atlanan) => (
                <li key={atlanan.productName}>
                  {atlanan.productName} — {ATLAMA_SEBEBI[atlanan.reason]}
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="dugme dugme-kucuk"
            style={{ marginTop: 10 }}
            onClick={() => router.push('/panel/sepet')}
          >
            Sepete Git
          </button>
        </div>
      )}

      {sablonlar.length === 0 ? (
        <div className="bos-durum">
          Henüz şablonunuz yok. Sepetinizi hazırlayıp{' '}
          <Link href="/panel/sepet">sepet sayfasından</Link> şablon olarak kaydedebilirsiniz.
        </div>
      ) : (
        <div className="liste">
          <div className="liste-satir baslik">
            <span>Şablon</span>
            <span>Kalem</span>
            <span>Kullanım</span>
            <span style={{ textAlign: 'right' }}>İşlem</span>
          </div>

          {sablonlar.map((sablon) => {
            const acik = acikSablon === sablon.id;
            const sahibi = sablon.ownerName === user?.fullName;
            const tukenmisSayisi = sablon.items.filter(
              (kalem) => kalem.stockStatus === StockStatus.OUT_OF_STOCK,
            ).length;

            return (
              <div key={sablon.id}>
                <div className="liste-satir">
                  <div>
                    <p className="urun-ad">{sablon.name}</p>
                    <p className="urun-alt">
                      {sablon.ownerName}
                      {sablon.isShared ? ' · işletme geneline açık' : ''}
                    </p>
                    {tukenmisSayisi > 0 && (
                      <span className="stok yok" style={{ marginTop: 4 }}>
                        {tukenmisSayisi} kalem tükenmiş
                      </span>
                    )}
                  </div>

                  <button
                    type="button"
                    className="dugme dugme-ikincil dugme-kucuk"
                    onClick={() => setAcikSablon(acik ? null : sablon.id)}
                  >
                    {sablon.itemCount} kalem
                  </button>

                  <span className="urun-alt">{sablon.useCount} kez kullanıldı</span>

                  <div className="satir-eylem">
                    <button
                      type="button"
                      className="dugme dugme-kucuk"
                      disabled={islemdeki === sablon.id}
                      onClick={() => void sepeteUygula(sablon)}
                    >
                      {islemdeki === sablon.id ? 'Uygulanıyor…' : 'Sepete Uygula'}
                    </button>
                    {sahibi && (
                      <button
                        type="button"
                        className="dugme dugme-ikincil dugme-kucuk"
                        disabled={islemdeki === sablon.id}
                        onClick={() => void sil(sablon)}
                      >
                        Sil
                      </button>
                    )}
                  </div>
                </div>

                {acik && (
                  <div style={{ padding: '0 16px 14px 16px' }}>
                    {sablon.items.map((kalem) => (
                      <div
                        key={`${kalem.productId}:${kalem.unitId}`}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          gap: 16,
                          padding: '5px 0',
                          fontSize: 13.5,
                        }}
                      >
                        <span>
                          {kalem.productName}{' '}
                          <span className="urun-alt">({kalem.productCode})</span>
                        </span>
                        <span className="urun-alt">
                          {miktar(kalem.quantity)} {kalem.unitCode}
                          {kalem.stockStatus === StockStatus.OUT_OF_STOCK ? ' · tükendi' : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
