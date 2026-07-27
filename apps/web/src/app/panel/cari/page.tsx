'use client';

/**
 * Cari Hesabim
 *
 * Bakiye isareti kuraldir: POZITIF deger BORCU gosterir. Muhasebe dilinde
 * "borc bakiye" alacakliya olan yukumluluktur; arayuz bunu tersine cevirmez,
 * yalnizca etiketle ("Borcunuz" / "Alacagınız") acikca soyler.
 *
 * Sipariş verilebilirligi arayuz HESAPLAMAZ: limit ve gecikmeyi karsilastirip
 * kendi karar veren bir istemci, sunucunun risk kalkani degistiginde sessizce
 * yanlis konusur. `canOrder` sunucudan gelir, arayuz onu gosterir.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  PaymentStatus,
  type AccountSummary,
  type AgingReport,
  type PaymentView,
} from '@toptanportal/contracts';

import { financeApi } from '../../../lib/api-client';
import { para, tarihSaat } from '../../../lib/bicim';
import { YaslandirmaKarti } from '../../../components/yaslandirma-karti';

export default function CariSayfasi() {
  const [ozet, setOzet] = useState<AccountSummary | null>(null);
  const [yaslandirma, setYaslandirma] = useState<AgingReport | null>(null);
  const [sonTahsilatlar, setSonTahsilatlar] = useState<PaymentView[]>([]);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState<string | null>(null);

  const yukle = useCallback(async () => {
    setYukleniyor(true);
    setHata(null);

    try {
      /* Yaslandirma ve tahsilat listesi ozetten bagimsizdir; birinin yetkisi
         olmayan rolde (or. yalnizca BALANCE_VIEW) sayfa yine de acilmalidir. */
      const [ozetSonuc, yaslandirmaSonuc, tahsilatSonuc] = await Promise.allSettled([
        financeApi.summary(),
        financeApi.aging(),
        financeApi.payments({ limit: 5 }),
      ]);

      if (ozetSonuc.status === 'rejected') throw ozetSonuc.reason;

      setOzet(ozetSonuc.value);
      setYaslandirma(yaslandirmaSonuc.status === 'fulfilled' ? yaslandirmaSonuc.value : null);
      setSonTahsilatlar(
        tahsilatSonuc.status === 'fulfilled' ? tahsilatSonuc.value.payments : [],
      );
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Cari hesap bilgileri yüklenemedi.');
    } finally {
      setYukleniyor(false);
    }
  }, []);

  useEffect(() => {
    void yukle();
  }, [yukle]);

  if (yukleniyor && !ozet) {
    return <div className="yukleniyor">Yükleniyor…</div>;
  }

  if (hata && !ozet) {
    return <div className="uyari-kutu hata">{hata}</div>;
  }

  if (!ozet) return null;

  const borclu = ozet.balance > 0;
  const bakiye = para(Math.abs(ozet.balance), ozet.currency);
  const gecikmis = para(ozet.overdueAmount, ozet.currency);
  const limit = para(ozet.creditLimit, ozet.currency);
  const kullanilabilir =
    ozet.availableCredit === null ? null : para(ozet.availableCredit, ozet.currency);
  const sonTahsilat =
    ozet.lastPaymentAmount === null ? null : para(ozet.lastPaymentAmount, ozet.currency);

  return (
    <div>
      <div className="sayfa-baslik">
        <div>
          <h2>Cari Hesabım</h2>
          <p>
            {ozet.companyTitle} · {ozet.paymentTermDays} gün vade ·{' '}
            {tarihSaat(ozet.calculatedAt)} itibarıyla
          </p>
        </div>
        <button
          type="button"
          className="dugme dugme-ikincil dugme-kucuk"
          disabled={yukleniyor}
          onClick={() => void yukle()}
        >
          {yukleniyor ? 'Yenileniyor…' : 'Yenile'}
        </button>
      </div>

      {ozet.isBlocked && (
        <div className="uyari-kutu hata">
          <strong>Hesabınız sipariş girişine kapalıdır.</strong>{' '}
          {ozet.blockReason ?? 'Ayrıntı için satış temsilcinizle görüşün.'}
        </div>
      )}

      {!ozet.isBlocked && !ozet.canOrder && (
        <div className="uyari-kutu dikkat">
          Açık hesap limitiniz dolduğu için yeni sipariş oluşturulamıyor. Ödeme
          yaptığınızda limit anında serbest kalır.
        </div>
      )}

      {!ozet.isBlocked && ozet.canOrder && ozet.overdueAmount > 0 && (
        <div className="uyari-kutu dikkat">
          {gecikmis} tutarında vadesi geçmiş borcunuz var ({ozet.overdueDays} gün).
          Sipariş girişiniz şimdilik açık.
        </div>
      )}

      <div className="olcum-izgara">
        <article className="olcum">
          <p className="olcum-etiket">{borclu ? 'Güncel Borcunuz' : 'Güncel Alacağınız'}</p>
          <p className={`olcum-deger ${borclu ? 'borc' : 'alacak'}`}>{bakiye ?? '—'}</p>
          <p className="olcum-alt">
            {ozet.openInvoiceCount > 0
              ? `${ozet.openInvoiceCount} açık belge`
              : 'Açık belge yok'}
          </p>
        </article>

        <article className="olcum">
          <p className="olcum-etiket">Vadesi Geçmiş</p>
          <p className={`olcum-deger ${ozet.overdueAmount > 0 ? 'gecikmis' : ''}`}>
            {gecikmis ?? '—'}
          </p>
          <p className="olcum-alt">
            {ozet.overdueDays > 0 ? `En eski gecikme: ${ozet.overdueDays} gün` : 'Gecikme yok'}
          </p>
        </article>

        <article className="olcum">
          <p className="olcum-etiket">Kullanılabilir Limit</p>
          <p className="olcum-deger">{kullanilabilir ?? 'Limitsiz'}</p>
          <p className="olcum-alt">
            {ozet.creditLimit > 0 ? `Tanımlı limit: ${limit}` : 'Açık hesap limiti tanımsız'}
          </p>
        </article>

        <article className="olcum">
          <p className="olcum-etiket">Son Tahsilat</p>
          <p className="olcum-deger">{sonTahsilat ?? '—'}</p>
          <p className="olcum-alt">
            {ozet.lastPaymentAt ? tarihSaat(ozet.lastPaymentAt) : 'Kayıtlı tahsilat yok'}
          </p>
        </article>
      </div>

      <div
        style={{
          display: 'grid',
          gap: 16,
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
        }}
      >
        {yaslandirma && <YaslandirmaKarti rapor={yaslandirma} />}

        <section className="yaslandirma">
          <h3>Son Tahsilatlar</h3>

          {sonTahsilatlar.length === 0 ? (
            <p className="olcum-alt" style={{ margin: 0 }}>
              Bu hesapta kayıtlı tahsilat bulunmuyor.
            </p>
          ) : (
            <ul className="kova-liste">
              {sonTahsilatlar.map((tahsilat) => {
                const tutar = para(tahsilat.amount, tahsilat.currency);

                return (
                  <li className="kova-satir" key={tahsilat.id}>
                    <span />
                    <span>
                      {tahsilat.methodLabel}
                      <span className="olcum-alt">
                        {' '}
                        · {tarihSaat(tahsilat.receivedAt)}
                        {tahsilat.status !== PaymentStatus.CONFIRMED
                          ? ` · ${tahsilat.statusLabel}`
                          : ''}
                      </span>
                    </span>
                    <span className="kova-tutar">{tutar ?? '—'}</span>
                  </li>
                );
              })}
            </ul>
          )}

          <p style={{ marginTop: 16, marginBottom: 0 }}>
            <Link href="/panel/odeme">Tüm tahsilatlar ve ödeme kaydı →</Link>
          </p>
        </section>
      </div>

      <p style={{ marginTop: 18 }}>
        <Link href="/panel/ekstre">Hareket dökümü için ekstreyi görüntüleyin →</Link>
      </p>
    </div>
  );
}
