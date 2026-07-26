'use client';

/**
 * Onay Bekleyen Siparisler
 *
 * Isletme yetkilisi burada alt kullanicilarinin siparislerini TUTARIYLA BIRLIKTE
 * gorur - onay kararinin dayanagi budur. Siparisi olusturan alt kullanici ayni
 * tutari gormez; asimetri bilinclidir.
 *
 * Kendi olusturdugu siparisi onaylamak sunucuda engellidir; bu sayfa da o
 * satirlarda onay dugmesini cizmez.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { OrderStatus, type OrderView } from '@toptanportal/contracts';

import { orderApi } from '../../../lib/api-client';
import { miktar, para, tarihSaat } from '../../../lib/bicim';
import { useSession } from '../../../lib/session-context';

export default function OnaylarSayfasi() {
  const { user } = useSession();
  const [siparisler, setSiparisler] = useState<OrderView[]>([]);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [islemdeki, setIslemdeki] = useState<string | null>(null);
  const [hata, setHata] = useState<string | null>(null);
  const [bildirim, setBildirim] = useState<string | null>(null);
  const [redSebepleri, setRedSebepleri] = useState<Record<string, string>>({});
  const [acikSatir, setAcikSatir] = useState<string | null>(null);

  const yukle = useCallback(async () => {
    setYukleniyor(true);
    try {
      const sayfa = await orderApi.list({ status: OrderStatus.PENDING_APPROVAL, limit: 50 });
      setSiparisler(sayfa.items);
      setHata(null);
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Siparişler yüklenemedi.');
    } finally {
      setYukleniyor(false);
    }
  }, []);

  useEffect(() => {
    void yukle();
  }, [yukle]);

  async function karar(
    siparis: OrderView,
    islem: 'onayla' | 'reddet',
  ): Promise<void> {
    const sebep = (redSebepleri[siparis.id] ?? '').trim();

    if (islem === 'reddet' && sebep.length < 3) {
      setHata('Ret gerekçesi zorunludur; sipariş sahibi neden reddedildiğini görmelidir.');
      return;
    }

    setIslemdeki(siparis.id);
    setHata(null);
    setBildirim(null);

    try {
      if (islem === 'onayla') {
        await orderApi.approve(siparis.id);
        setBildirim(`${siparis.orderNumber} onaylandı ve muhasebe sistemine iletiliyor.`);
      } else {
        await orderApi.reject(siparis.id, sebep);
        setBildirim(`${siparis.orderNumber} reddedildi; ayrılan stok serbest bırakıldı.`);
      }

      setSiparisler((oncekiler) => oncekiler.filter((s) => s.id !== siparis.id));
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'İşlem tamamlanamadı.');
    } finally {
      setIslemdeki(null);
    }
  }

  if (yukleniyor) return <div className="bos-durum">Yükleniyor…</div>;

  return (
    <div>
      <div className="sayfa-baslik">
        <div>
          <h2>Onay Bekleyen Siparişler</h2>
          <p>
            {siparisler.length === 0
              ? 'Onayınızı bekleyen sipariş yok.'
              : `${siparisler.length} sipariş onayınızı bekliyor. Onaylanana kadar stok ayrılmış durumda tutulur.`}
          </p>
        </div>
      </div>

      {hata && <div className="uyari-kutu hata">{hata}</div>}
      {bildirim && <div className="uyari-kutu bilgi">{bildirim}</div>}

      {siparisler.length === 0 ? (
        <div className="bos-durum">
          Bekleyen sipariş bulunmuyor. <Link href="/panel/siparisler">Tüm siparişler</Link>
        </div>
      ) : (
        siparisler.map((siparis) => {
          const kendiSiparisi = siparis.createdByName === user?.fullName;
          const acik = acikSatir === siparis.id;

          return (
            <section
              key={siparis.id}
              className="toplam-kutu"
              style={{ marginBottom: 14, minWidth: 0 }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 16,
                  flexWrap: 'wrap',
                  alignItems: 'flex-start',
                }}
              >
                <div>
                  <p className="urun-ad" style={{ fontSize: 15 }}>
                    <Link href={`/panel/siparisler/${siparis.id}`}>{siparis.orderNumber}</Link>
                  </p>
                  <p className="urun-alt">
                    {siparis.createdByName} · {tarihSaat(siparis.submittedAt)} ·{' '}
                    {siparis.lines.length} kalem
                  </p>
                  {siparis.customerNote && (
                    <p className="urun-alt">Not: {siparis.customerNote}</p>
                  )}
                </div>

                <div style={{ textAlign: 'right' }}>
                  <div className="fiyat" style={{ fontSize: 18 }}>
                    {para(siparis.grandTotal, siparis.currency) ?? '—'}
                  </div>
                  <button
                    type="button"
                    className="dugme dugme-ikincil dugme-kucuk"
                    style={{ marginTop: 8 }}
                    onClick={() => setAcikSatir(acik ? null : siparis.id)}
                  >
                    {acik ? 'Kalemleri Gizle' : 'Kalemleri Göster'}
                  </button>
                </div>
              </div>

              {acik && (
                <div style={{ marginTop: 12, borderTop: '1px solid var(--kenarlik)' }}>
                  {siparis.lines.map((satir) => (
                    <div
                      key={satir.lineNumber}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 16,
                        padding: '6px 0',
                        fontSize: 13.5,
                      }}
                    >
                      <span>
                        {satir.productName}{' '}
                        <span className="urun-alt">
                          ({miktar(satir.quantity)} {satir.unitCode})
                        </span>
                      </span>
                      <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {para(satir.lineTotal, siparis.currency) ?? '—'}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {kendiSiparisi ? (
                <p className="urun-alt" style={{ marginTop: 12 }}>
                  Kendi oluşturduğunuz siparişi onaylayamazsınız.
                </p>
              ) : (
                <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="dugme dugme-kucuk"
                    disabled={islemdeki === siparis.id}
                    onClick={() => void karar(siparis, 'onayla')}
                  >
                    {islemdeki === siparis.id ? 'İşleniyor…' : 'Onayla'}
                  </button>
                  <input
                    className="alan-girdi"
                    style={{ height: 36, flex: '1 1 240px' }}
                    type="text"
                    maxLength={500}
                    placeholder="Ret gerekçesi"
                    value={redSebepleri[siparis.id] ?? ''}
                    onChange={(olay) =>
                      setRedSebepleri((oncekiler) => ({
                        ...oncekiler,
                        [siparis.id]: olay.target.value,
                      }))
                    }
                  />
                  <button
                    type="button"
                    className="dugme dugme-ikincil dugme-kucuk"
                    disabled={islemdeki === siparis.id}
                    onClick={() => void karar(siparis, 'reddet')}
                  >
                    Reddet
                  </button>
                </div>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}
