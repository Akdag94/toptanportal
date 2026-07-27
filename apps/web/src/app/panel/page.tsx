'use client';

/**
 * Panel giris ekrani. Icerik role gore degisir; Kor Siparis Modunda hicbir
 * finansal kart olusturulmaz.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Permission,
  ROLE_LABELS,
  UserRole,
  type AccountSummary,
} from '@toptanportal/contracts';

import { financeApi } from '../../lib/api-client';
import { para } from '../../lib/bicim';
import { useSession } from '../../lib/session-context';

interface Kart {
  baslik: string;
  aciklama: string;
  gorunur: (yetkiler: Set<Permission>) => boolean;
}

const KARTLAR: Kart[] = [
  {
    baslik: 'Rutin Siparişim',
    aciklama:
      'Kayıtlı sipariş şablonlarınızı tek dokunuşla sepete aktarın; stok ve limit kontrolü otomatik yapılır.',
    gorunur: (yetkiler) => yetkiler.has(Permission.ORDER_TEMPLATE_MANAGE),
  },
  {
    baslik: 'Ürün Kataloğu',
    aciklama: 'Güncel stok durumu ve birim çevrimleriyle ürünleri inceleyin.',
    gorunur: (yetkiler) => yetkiler.has(Permission.CATALOG_VIEW),
  },
  {
    baslik: 'Onay Bekleyen Siparişler',
    aciklama: 'Alt kullanıcılarınızın gönderdiği sipariş taleplerini inceleyip onaylayın.',
    gorunur: (yetkiler) => yetkiler.has(Permission.ORDER_APPROVE),
  },
  {
    baslik: 'Ekstre ve Yaşlandırma',
    aciklama:
      'Hareket dökümünüzü dönem seçerek görüntüleyin, mutabakat için Excel’e aktarın.',
    gorunur: (yetkiler) => yetkiler.has(Permission.STATEMENT_VIEW),
  },
  {
    baslik: 'e-Fatura Arşivi',
    aciklama: 'Kesilen e-Fatura ve e-İrsaliye evraklarınıza 10 yıl boyunca erişin.',
    gorunur: (yetkiler) => yetkiler.has(Permission.INVOICE_DOWNLOAD),
  },
  {
    baslik: 'Toplu Sipariş Yükleme',
    aciklama: 'Stok Kodu;Adet biçimindeki Excel dosyanızı sürükleyip sepete dönüştürün.',
    gorunur: (yetkiler) => yetkiler.has(Permission.ORDER_IMPORT_BULK),
  },
  {
    baslik: 'Bayi Portföyüm',
    aciklama: 'Atanmış bayilerinizi listeleyin, adlarına sipariş girin, ziyaret notu ekleyin.',
    gorunur: (yetkiler) => yetkiler.has(Permission.COMPANY_VIEW_ASSIGNED),
  },
  {
    baslik: 'Denetim Kayıtları',
    aciklama:
      'Hash zinciriyle korunan, değiştirilemez işlem kayıtlarını inceleyin ve dışa aktarın.',
    gorunur: (yetkiler) => yetkiler.has(Permission.AUDIT_LOG_VIEW),
  },
];

/**
 * Cari serit yalnizca BALANCE_VIEW yetkisiyle CEKILIR - Kor Siparis Modundaki
 * hesapta istek hic olusturulmaz. Yuklenemezse serit sessizce gizlenir:
 * anasayfada bir hata kutusu, kullanicinin yapabilecegi bir sey olmadigi halde
 * gunu kotu baslatir; veri cari sayfasinda zaten yeniden denenir.
 */
function CariSerit() {
  const [ozet, setOzet] = useState<AccountSummary | null>(null);

  useEffect(() => {
    financeApi
      .summary()
      .then(setOzet)
      .catch(() => setOzet(null));
  }, []);

  if (!ozet) return null;

  const borclu = ozet.balance > 0;

  return (
    <div className="olcum-izgara">
      <article className="olcum">
        <p className="olcum-etiket">{borclu ? 'Güncel Borcunuz' : 'Güncel Alacağınız'}</p>
        <p className={`olcum-deger ${borclu ? 'borc' : 'alacak'}`}>
          {para(Math.abs(ozet.balance), ozet.currency) ?? '—'}
        </p>
        <p className="olcum-alt">
          <Link href="/panel/cari">Cari hesap ayrıntısı →</Link>
        </p>
      </article>

      <article className="olcum">
        <p className="olcum-etiket">Vadesi Geçmiş</p>
        <p className={`olcum-deger ${ozet.overdueAmount > 0 ? 'gecikmis' : ''}`}>
          {para(ozet.overdueAmount, ozet.currency) ?? '—'}
        </p>
        <p className="olcum-alt">
          {ozet.overdueDays > 0 ? `${ozet.overdueDays} gün gecikme` : 'Gecikme yok'}
        </p>
      </article>

      <article className="olcum">
        <p className="olcum-etiket">Sipariş Durumu</p>
        <p className={`olcum-deger ${ozet.canOrder ? 'alacak' : 'gecikmis'}`}>
          {ozet.canOrder ? 'Açık' : 'Kapalı'}
        </p>
        <p className="olcum-alt">
          {ozet.canOrder
            ? ozet.availableCredit === null
              ? 'Limit tanımsız'
              : `Kullanılabilir limit: ${para(ozet.availableCredit, ozet.currency)}`
            : (ozet.blockReason ?? 'Açık hesap limitiniz dolu.')}
        </p>
      </article>
    </div>
  );
}

export default function PanelAnasayfa() {
  const { user } = useSession();
  if (!user) return null;

  const yetkiler = new Set(user.permissions);
  const gorunurKartlar = KARTLAR.filter((kart) => kart.gorunur(yetkiler));

  return (
    <div>
      <div className="sayfa-baslik">
        <div>
          <h2>Hoş geldiniz, {user.fullName.split(' ')[0]}</h2>
          <p>
            {ROLE_LABELS[user.role]}
            {user.companyTitle ? ` · ${user.companyTitle}` : ''}
          </p>
        </div>
      </div>

      {user.blindOrderMode && (
        <div className="uyari-kutu dikkat">
          Hesabınız sipariş oluşturma yetkisine sahiptir. Fiyat, iskonto, fatura ve cari
          borç bilgileri bu hesapta gösterilmez; oluşturduğunuz sipariş işletme
          yetkilinizin onayına gönderilir.
        </div>
      )}

      {user.role === UserRole.BUSINESS_ACCOUNTANT && (
        <div className="uyari-kutu bilgi">
          Muhasebe hesabınızla sipariş oluşturulamaz. Evrak, ekstre ve ödeme işlemlerine
          erişebilirsiniz.
        </div>
      )}

      {yetkiler.has(Permission.BALANCE_VIEW) && <CariSerit />}

      <div className="kart-izgara">
        {gorunurKartlar.map((kart) => (
          <article className="kart" key={kart.baslik}>
            <h3>{kart.baslik}</h3>
            <p>{kart.aciklama}</p>
          </article>
        ))}
      </div>
    </div>
  );
}
