'use client';

/**
 * Siparis Listesi
 *
 * Kapsam SUNUCU tarafindan belirlenir: alt yetkili yalnizca kendi
 * siparislerini, isletme yetkilisi ve muhasebeci isletmenin tamamini gorur.
 * Arayuz ayrica bir suzgec uygulamaz - iki farkli kapsam tanimi birbirinden
 * ayrisirsa hangisinin dogru oldugu belirsizlesir.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ORDER_STATUS_LABELS,
  OrderStatus,
  type OrderView,
} from '@toptanportal/contracts';

import { orderApi } from '../../../lib/api-client';
import { para, tarihSaat } from '../../../lib/bicim';

/** Durum rozeti renkleri: bekleyen sari, olumlu yesil, olumsuz kirmizi. */
const DURUM_SINIF: Record<OrderStatus, string> = {
  [OrderStatus.PENDING_APPROVAL]: 'kritik',
  [OrderStatus.QUEUED]: 'kritik',
  [OrderStatus.SENDING]: 'kritik',
  [OrderStatus.CONFIRMED]: 'var',
  [OrderStatus.REJECTED]: 'yok',
  [OrderStatus.CANCELLED]: 'yok',
  [OrderStatus.FAILED]: 'yok',
};

const SUZGECLER: { etiket: string; durum?: OrderStatus }[] = [
  { etiket: 'Tümü' },
  { etiket: 'Onay Bekleyen', durum: OrderStatus.PENDING_APPROVAL },
  { etiket: 'İletiliyor', durum: OrderStatus.QUEUED },
  { etiket: 'Onaylandı', durum: OrderStatus.CONFIRMED },
  { etiket: 'İptal', durum: OrderStatus.CANCELLED },
];

export default function SiparislerSayfasi() {
  const [siparisler, setSiparisler] = useState<OrderView[]>([]);
  const [sonrakiImlec, setSonrakiImlec] = useState<string | null>(null);
  const [durum, setDurum] = useState<OrderStatus | undefined>(undefined);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState<string | null>(null);

  const yukle = useCallback(
    async (imlec?: string) => {
      setYukleniyor(true);
      setHata(null);

      try {
        const sayfa = await orderApi.list({ status: durum, cursor: imlec, limit: 25 });
        setSonrakiImlec(sayfa.nextCursor);
        setSiparisler((oncekiler) => (imlec ? [...oncekiler, ...sayfa.items] : sayfa.items));
      } catch (error) {
        setHata(error instanceof Error ? error.message : 'Siparişler yüklenemedi.');
      } finally {
        setYukleniyor(false);
      }
    },
    [durum],
  );

  useEffect(() => {
    void yukle();
  }, [yukle]);

  return (
    <div>
      <div className="sayfa-baslik">
        <div>
          <h2>Siparişler</h2>
          <p>Sipariş numarasına tıklayarak kalem dökümünü görebilirsiniz.</p>
        </div>
      </div>

      <div className="arac-cubugu">
        {SUZGECLER.map((suzgec) => (
          <button
            key={suzgec.etiket}
            type="button"
            className={`dugme dugme-kucuk ${durum === suzgec.durum ? '' : 'dugme-ikincil'}`}
            onClick={() => setDurum(suzgec.durum)}
          >
            {suzgec.etiket}
          </button>
        ))}
      </div>

      {hata && <div className="uyari-kutu hata">{hata}</div>}

      {siparisler.length === 0 && !yukleniyor ? (
        <div className="bos-durum">Bu ölçütlere uyan sipariş bulunmuyor.</div>
      ) : (
        <div className="liste">
          <div className="liste-satir baslik">
            <span>Sipariş</span>
            <span>Durum</span>
            <span>Tutar</span>
            <span style={{ textAlign: 'right' }}>Tarih</span>
          </div>

          {siparisler.map((siparis) => {
            const tutar = para(siparis.grandTotal, siparis.currency);

            return (
              <div className="liste-satir" key={siparis.id}>
                <div>
                  <p className="urun-ad">
                    <Link href={`/panel/siparisler/${siparis.id}`}>{siparis.orderNumber}</Link>
                  </p>
                  <p className="urun-alt">
                    {siparis.lines.length} kalem · {siparis.createdByName}
                    {siparis.logoOrderNumber ? ` · Logo: ${siparis.logoOrderNumber}` : ''}
                  </p>
                </div>

                <span className={`stok ${DURUM_SINIF[siparis.status]}`}>
                  {ORDER_STATUS_LABELS[siparis.status]}
                </span>

                <div>
                  {tutar ? <span className="fiyat">{tutar}</span> : <span className="fiyat-alt">—</span>}
                </div>

                <span className="urun-alt" style={{ textAlign: 'right' }}>
                  {tarihSaat(siparis.submittedAt)}
                </span>
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
