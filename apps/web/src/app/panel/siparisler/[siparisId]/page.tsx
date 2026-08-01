'use client';

/**
 * Siparis Ayrinti
 *
 * Belge niteligindedir: satirlar siparis anindaki urun adi, kodu ve fiyatiyla
 * saklanir; urun karti sonradan degisse de bu sayfa degismez.
 *
 * Iptal yalnizca Logo'ya iletilmemis siparislerde mumkundur. Iletilmis bir
 * siparisi portalden iptal etmek, muhasebe sistemiyle portali ayristirir.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  ORDER_STATUS_LABELS,
  OrderStatus,
  Permission,
  type IssueEDocumentResult,
  type OrderView,
} from '@toptanportal/contracts';

import { eDocumentApi, orderApi } from '../../../../lib/api-client';
import { gun, miktar, para, tarihSaat } from '../../../../lib/bicim';
import { useSession } from '../../../../lib/session-context';

const IPTAL_EDILEBILIR: OrderStatus[] = [OrderStatus.PENDING_APPROVAL, OrderStatus.QUEUED];

/** Belge yalnizca Logo'da onaylanmis siparisten kesilir. */
const BELGE_KESILEBILIR: OrderStatus[] = [OrderStatus.CONFIRMED];

export default function SiparisAyrintiSayfasi() {
  const { user } = useSession();
  const router = useRouter();
  const parametreler = useParams<{ siparisId: string }>();
  const siparisId = parametreler.siparisId;

  const [siparis, setSiparis] = useState<OrderView | null>(null);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [islemde, setIslemde] = useState(false);
  const [hata, setHata] = useState<string | null>(null);
  const [belge, setBelge] = useState<IssueEDocumentResult | null>(null);

  const yukle = useCallback(async () => {
    setYukleniyor(true);
    try {
      setSiparis(await orderApi.detail(siparisId));
      setHata(null);
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Sipariş bulunamadı.');
    } finally {
      setYukleniyor(false);
    }
  }, [siparisId]);

  useEffect(() => {
    void yukle();
  }, [yukle]);

  async function iptalEt(): Promise<void> {
    setIslemde(true);
    setHata(null);

    try {
      setSiparis(await orderApi.cancel(siparisId));
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Sipariş iptal edilemedi.');
    } finally {
      setIslemde(false);
    }
  }

  /**
   * Belge kesme GERI ALINAMAZ: numara tüketilir, belge hukuken doğar ve
   * düzeltmesi ancak iade faturasıyla yapılır. Bu yüzden düğme onay ister —
   * yanlışlıkla basılan bir düğme, defteri açıklanması gereken bir satırla
   * doldurur.
   */
  async function belgeKes(): Promise<void> {
    if (!window.confirm('Bu siparişten e-Belge kesilecek. İşlem geri alınamaz; devam edilsin mi?')) {
      return;
    }

    setIslemde(true);
    setHata(null);

    try {
      setBelge(await eDocumentApi.issue({ orderId: siparisId }));
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Belge kesilemedi.');
    } finally {
      setIslemde(false);
    }
  }

  if (yukleniyor) return <div className="bos-durum">Yükleniyor…</div>;
  if (!siparis) return <div className="uyari-kutu hata">{hata ?? 'Sipariş bulunamadı.'}</div>;

  const yetkiler = new Set(user?.permissions ?? []);
  const iptalEdilebilir =
    yetkiler.has(Permission.ORDER_CANCEL) && IPTAL_EDILEBILIR.includes(siparis.status);
  /* Belge yalnizca ONAYLANMIS siparisten kesilir: onay bekleyen bir siparisin
     faturasi, henuz alinmamis bir karari belgelemis olurdu. */
  const belgeKesilebilir =
    yetkiler.has(Permission.EDOCUMENT_ISSUE) && BELGE_KESILEBILIR.includes(siparis.status);
  const toplam = para(siparis.grandTotal, siparis.currency);

  return (
    <div>
      <div className="sayfa-baslik">
        <div>
          <h2>{siparis.orderNumber}</h2>
          <p>
            {ORDER_STATUS_LABELS[siparis.status]} · {tarihSaat(siparis.submittedAt)} ·{' '}
            {siparis.companyTitle}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="dugme dugme-ikincil dugme-kucuk" href="/panel/siparisler">
            Listeye Dön
          </Link>
          {iptalEdilebilir && (
            <button
              type="button"
              className="dugme dugme-ikincil dugme-kucuk"
              disabled={islemde}
              onClick={() => void iptalEt()}
            >
              {islemde ? 'İptal ediliyor…' : 'Siparişi İptal Et'}
            </button>
          )}
          {belgeKesilebilir && belge === null && (
            <button
              type="button"
              className="dugme dugme-kucuk"
              disabled={islemde}
              onClick={() => void belgeKes()}
            >
              {islemde ? 'Kesiliyor…' : 'e-Belge Kes'}
            </button>
          )}
        </div>
      </div>

      {hata && <div className="uyari-kutu hata">{hata}</div>}

      {belge && (
        <div className="uyari-kutu bilgi">
          <strong>{belge.document.documentNumber}</strong> numaralı{' '}
          {belge.document.kindLabel.toLocaleLowerCase('tr-TR')} kesildi. Belge arşive yazıldı;
          entegratöre iletim arka planda yapılır ve durumu{' '}
          <Link href="/panel/evraklar">Evraklar</Link> ekranından izlenir.
          {belge.warnings.length > 0 && (
            /* Uyarilar SESSIZCE yutulmaz: belge kesilmistir ve geri alinamaz,
               uyari o yuzden ekranda durur. */
            <ul style={{ margin: '8px 0 0 18px' }}>
              {belge.warnings.map((uyari) => (
                <li key={uyari}>{uyari}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {siparis.status === OrderStatus.REJECTED && siparis.rejectReason && (
        <div className="uyari-kutu hata">
          <strong>Reddedildi:</strong> {siparis.rejectReason}
        </div>
      )}

      {siparis.status === OrderStatus.PENDING_APPROVAL && (
        <div className="uyari-kutu dikkat">
          Bu sipariş işletme yetkilisinin onayını bekliyor; muhasebe sistemine henüz
          iletilmedi.
        </div>
      )}

      <div className="liste" style={{ marginBottom: 20 }}>
        <div className="liste-satir baslik">
          <span>Ürün</span>
          <span>Miktar</span>
          <span>{siparis.blindOrderMode ? '' : 'Birim Fiyat'}</span>
          <span style={{ textAlign: 'right' }}>{siparis.blindOrderMode ? '' : 'Tutar'}</span>
        </div>

        {siparis.lines.map((satir) => (
          <div className="liste-satir" key={satir.lineNumber}>
            <div>
              <p className="urun-ad">{satir.productName}</p>
              <p className="urun-alt">{satir.productCode}</p>
              {satir.note && <p className="urun-alt">Not: {satir.note}</p>}
            </div>

            <span className="urun-alt">
              {miktar(satir.quantity)} {satir.unitCode}
            </span>

            <span className="urun-alt">
              {para(satir.unitPrice, siparis.currency) ?? '—'}
            </span>

            <span className="fiyat" style={{ textAlign: 'right' }}>
              {para(satir.lineTotal, siparis.currency) ?? '—'}
            </span>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div className="toplam-kutu" style={{ flex: '1 1 320px' }}>
          <div className="toplam-satir">
            <span>Sevk ambarı</span>
            <span>{siparis.warehouseName}</span>
          </div>
          <div className="toplam-satir">
            <span>Oluşturan</span>
            <span>{siparis.createdByName}</span>
          </div>
          {siparis.approvedByName && (
            <div className="toplam-satir">
              <span>Onaylayan</span>
              <span>{siparis.approvedByName}</span>
            </div>
          )}
          <div className="toplam-satir">
            <span>İstenen teslim tarihi</span>
            <span>{gun(siparis.requestedDeliveryDate)}</span>
          </div>
          {siparis.logoOrderNumber && (
            <div className="toplam-satir">
              <span>Logo fiş numarası</span>
              <span>{siparis.logoOrderNumber}</span>
            </div>
          )}
          {siparis.customerNote && (
            <div className="toplam-satir">
              <span>Sipariş notu</span>
              <span>{siparis.customerNote}</span>
            </div>
          )}
        </div>

        {!siparis.blindOrderMode && (
          <div className="toplam-kutu">
            <div className="toplam-satir">
              <span>Ara toplam</span>
              <span>{para(siparis.grossTotal, siparis.currency)}</span>
            </div>
            {typeof siparis.discountTotal === 'number' && siparis.discountTotal > 0 && (
              <div className="toplam-satir">
                <span>İskonto</span>
                <span>-{para(siparis.discountTotal, siparis.currency)}</span>
              </div>
            )}
            <div className="toplam-satir">
              <span>Net</span>
              <span>{para(siparis.netTotal, siparis.currency)}</span>
            </div>
            <div className="toplam-satir">
              <span>KDV</span>
              <span>{para(siparis.vatTotal, siparis.currency)}</span>
            </div>
            <div className="toplam-satir genel">
              <span>Genel Toplam</span>
              <span>{toplam}</span>
            </div>
          </div>
        )}
      </div>

      {siparis.status === OrderStatus.CANCELLED && (
        <div style={{ marginTop: 16 }}>
          <button
            type="button"
            className="dugme dugme-ikincil dugme-kucuk"
            onClick={() => router.push('/panel/katalog')}
          >
            Yeni Sipariş Oluştur
          </button>
        </div>
      )}
    </div>
  );
}
