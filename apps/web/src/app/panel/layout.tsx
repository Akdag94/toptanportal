'use client';

/**
 * ToptanPortal Web - Panel Kabugu
 *
 * Menu, rolun YETKILERINDEN turetilir. Yetkisi olmayan bir baglanti hic
 * olusturulmaz - kullaniciya gorunmeyen bir kapiyi zorlamasi gerektigi
 * hissettirilmez. Sunucu tarafi denetim yine de bagimsizdir; bu katman
 * yalnizca kullanilabilirlik icindir.
 */

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Permission, ROLE_LABELS } from '@toptanportal/contracts';

import { useSession } from '../../lib/session-context';

interface MenuOgesi {
  baslik: string;
  yol: string;
  /** Bu yetkilerden en az biri gerekir. Bos dizi: herkese acik. */
  yetkiler: Permission[];
}

interface MenuGrubu {
  baslik: string;
  ogeler: MenuOgesi[];
}

const MENU: MenuGrubu[] = [
  {
    baslik: 'Sipariş',
    ogeler: [
      {
        baslik: 'Genel Bakış',
        yol: '/panel',
        yetkiler: [Permission.CATALOG_VIEW, Permission.ORDER_VIEW_COMPANY],
      },
      {
        baslik: 'Ürün Kataloğu',
        yol: '/panel/katalog',
        yetkiler: [Permission.CATALOG_VIEW],
      },
      {
        baslik: 'Sepetim',
        yol: '/panel/sepet',
        yetkiler: [Permission.ORDER_DRAFT],
      },
      {
        baslik: 'Rutin Şablonlarım',
        yol: '/panel/sablonlar',
        yetkiler: [Permission.ORDER_TEMPLATE_MANAGE],
      },
      {
        baslik: 'Siparişlerim',
        yol: '/panel/siparisler',
        yetkiler: [
          Permission.ORDER_VIEW_OWN,
          Permission.ORDER_VIEW_COMPANY,
          Permission.ORDER_VIEW_ALL,
        ],
      },
      {
        baslik: 'Toplu Sipariş (Excel)',
        yol: '/panel/toplu-siparis',
        yetkiler: [Permission.ORDER_IMPORT_BULK],
      },
      {
        baslik: 'Onay Bekleyenler',
        yol: '/panel/onaylar',
        yetkiler: [Permission.ORDER_APPROVE],
      },
    ],
  },
  {
    baslik: 'Finans',
    ogeler: [
      {
        baslik: 'Cari Hesabım',
        yol: '/panel/cari',
        yetkiler: [Permission.BALANCE_VIEW],
      },
      {
        baslik: 'Ekstre ve Yaşlandırma',
        yol: '/panel/ekstre',
        yetkiler: [Permission.STATEMENT_VIEW],
      },
      {
        baslik: 'e-Fatura / e-İrsaliye',
        yol: '/panel/evraklar',
        yetkiler: [Permission.INVOICE_DOWNLOAD],
      },
      {
        baslik: 'Ödeme Yap',
        yol: '/panel/odeme',
        yetkiler: [Permission.PAYMENT_CREATE],
      },
    ],
  },
  {
    baslik: 'Saha',
    ogeler: [
      {
        baslik: 'Bayilerim',
        yol: '/panel/bayiler',
        yetkiler: [Permission.COMPANY_VIEW_ASSIGNED, Permission.COMPANY_VIEW_ALL],
      },
      {
        baslik: 'Ziyaret Notları',
        yol: '/panel/ziyaretler',
        yetkiler: [Permission.VISIT_NOTE_MANAGE],
      },
      {
        baslik: 'Hedef ve Prim',
        yol: '/panel/hedefler',
        yetkiler: [Permission.SALES_TARGET_VIEW_OWN],
      },
    ],
  },
  {
    baslik: 'Hesap',
    ogeler: [
      {
        baslik: 'Hesap Güvenliği',
        yol: '/panel/guvenlik',
        // Herkese acik: iki adimli dogrulama istege baglidir ve her kullanici
        // kendi oturumlarini gorebilmelidir.
        yetkiler: [],
      },
      {
        baslik: 'Bildirim Tercihleri',
        yol: '/panel/bildirimler',
        // Herkese acik: hangi bildirimi alacagina kullanici karar verir.
        yetkiler: [],
      },
    ],
  },
  {
    baslik: 'Yönetim',
    ogeler: [
      {
        baslik: 'Kullanıcılar',
        yol: '/panel/kullanicilar',
        yetkiler: [Permission.USER_MANAGE_COMPANY, Permission.USER_MANAGE_ALL],
      },
      {
        baslik: 'Fiyat Listeleri',
        yol: '/panel/fiyat-listeleri',
        yetkiler: [Permission.PRICE_LIST_MANAGE],
      },
      {
        baslik: 'Katalog Yönetimi',
        yol: '/panel/katalog-yonetimi',
        yetkiler: [Permission.CATALOG_MANAGE],
      },
      {
        baslik: 'Logo Entegrasyonu',
        yol: '/panel/entegrasyon',
        yetkiler: [Permission.INTEGRATION_MANAGE],
      },
      {
        baslik: 'Denetim Kayıtları',
        yol: '/panel/denetim',
        yetkiler: [Permission.AUDIT_LOG_VIEW],
      },
      {
        baslik: 'Bildirim Kaydı',
        yol: '/panel/bildirim-kaydi',
        yetkiler: [Permission.NOTIFICATION_LOG_VIEW],
      },
      {
        baslik: 'Bildirim Metinleri',
        yol: '/panel/bildirim-metinleri',
        yetkiler: [Permission.NOTIFICATION_TEMPLATE_MANAGE],
      },
    ],
  },
];

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, signOut } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !user) router.replace('/giris');
  }, [user, loading, router]);

  if (loading || !user) {
    return <div className="yukleniyor">Yükleniyor…</div>;
  }

  const yetkiler = new Set(user.permissions);
  const gruplar = MENU.map((grup) => ({
    baslik: grup.baslik,
    ogeler: grup.ogeler.filter(
      (oge) => oge.yetkiler.length === 0 || oge.yetkiler.some((yetki) => yetkiler.has(yetki)),
    ),
  })).filter((grup) => grup.ogeler.length > 0);

  return (
    <div className="kabuk">
      <nav className="yan-menu" aria-label="Ana menü">
        <div>
          <h1 className="marka">ToptanPortal</h1>
          {gruplar.map((grup) => (
            <section key={grup.baslik}>
              <h2 className="yan-menu-baslik">{grup.baslik}</h2>
              <ul className="menu-liste">
                {grup.ogeler.map((oge) => (
                  <li key={oge.yol}>
                    <Link
                      className="menu-baglanti"
                      href={oge.yol}
                      aria-current={pathname === oge.yol ? 'page' : undefined}
                    >
                      {oge.baslik}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </nav>

      <div className="icerik">
        <header className="ust-cubuk">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {user.blindOrderMode && (
              <span className="rozet kor-mod" title="Fiyat, iskonto ve bakiye bilgileri gösterilmez.">
                Kör Sipariş Modu
              </span>
            )}
            {user.masqueradingAs && (
              <span className="rozet vekalet">
                {user.masqueradingAs.companyTitle} adına işlem yapılıyor
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div className="kullanici-kutu">
              <div className="kullanici-adi">{user.fullName}</div>
              <div className="kullanici-rol">
                {ROLE_LABELS[user.role]}
                {user.companyTitle ? ` · ${user.companyTitle}` : ''}
              </div>
            </div>
            <button
              className="dugme dugme-ikincil dugme-kucuk"
              type="button"
              onClick={() => {
                void signOut(false).then(() => router.replace('/giris'));
              }}
            >
              Çıkış
            </button>
          </div>
        </header>

        {children}
      </div>
    </div>
  );
}
