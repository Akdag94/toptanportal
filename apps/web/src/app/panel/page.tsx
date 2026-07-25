'use client';

/**
 * Panel giris ekrani. Icerik role gore degisir; Kor Siparis Modunda hicbir
 * finansal kart olusturulmaz.
 */

import { Permission, ROLE_LABELS, UserRole } from '@toptanportal/contracts';

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
    baslik: 'Cari Hesap Durumu',
    aciklama: 'Güncel bakiye, kredi limiti ve vadesi yaklaşan borçlarınız.',
    gorunur: (yetkiler) => yetkiler.has(Permission.BALANCE_VIEW),
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

export default function PanelAnasayfa() {
  const { user } = useSession();
  if (!user) return null;

  const yetkiler = new Set(user.permissions);
  const gorunurKartlar = KARTLAR.filter((kart) => kart.gorunur(yetkiler));

  return (
    <div>
      <h2 style={{ margin: '0 0 4px', fontSize: 22, letterSpacing: '-0.02em' }}>
        Hoş geldiniz, {user.fullName.split(' ')[0]}
      </h2>
      <p style={{ margin: '0 0 24px', color: 'var(--metin-ikincil)', fontSize: 14 }}>
        {ROLE_LABELS[user.role]}
        {user.companyTitle ? ` · ${user.companyTitle}` : ''}
      </p>

      {user.blindOrderMode && (
        <div className="uyari-kutu dikkat" style={{ maxWidth: 720 }}>
          Hesabınız sipariş oluşturma yetkisine sahiptir. Fiyat, iskonto, fatura ve cari
          borç bilgileri bu hesapta gösterilmez; oluşturduğunuz sipariş işletme
          yetkilinizin onayına gönderilir.
        </div>
      )}

      {user.role === UserRole.BUSINESS_ACCOUNTANT && (
        <div className="uyari-kutu bilgi" style={{ maxWidth: 720 }}>
          Muhasebe hesabınızla sipariş oluşturulamaz. Evrak, ekstre ve ödeme işlemlerine
          erişebilirsiniz.
        </div>
      )}

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
