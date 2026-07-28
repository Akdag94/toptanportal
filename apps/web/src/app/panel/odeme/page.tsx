'use client';

/**
 * Tahsilat / Odeme
 *
 * Iki farkli kullanici bu ekrani paylasir:
 *   * Isletme yetkilisi kendi odemesini bildirir (PAYMENT_CREATE)
 *   * Plasiyer saha tahsilatini kaydeder (COLLECTION_RECORD)
 * Ayrimi arayuz DEGIL sunucu yapar; buradaki tek fark, plasiyerin bayi
 * secmesi gerekmesidir.
 *
 * Kayit butonu Idempotency-Key ile calisir ve anahtar ancak BASARILI yanittan
 * sonra tazelenir: zayif baglantida ikinci dokunus ayni tahsilati tekrar
 * yazmaz, cunku sunucu ayni anahtari gorur.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  PAYMENT_METHOD_LABELS,
  PaymentMethod,
  PaymentStatus,
  Permission,
  SELF_CONFIRMING_METHODS,
  type PaymentView,
} from '@toptanportal/contracts';

import { ApiError, financeApi, posApi } from '../../../lib/api-client';
import { para, tarihSaat } from '../../../lib/bicim';
import { useSession } from '../../../lib/session-context';

const DURUM_SINIF: Record<PaymentStatus, string> = {
  [PaymentStatus.PENDING]: 'kritik',
  [PaymentStatus.CONFIRMED]: 'var',
  [PaymentStatus.FAILED]: 'yok',
  [PaymentStatus.CANCELLED]: 'yok',
};

export default function OdemeSayfasi() {
  const { user } = useSession();
  const yetkiler = new Set(user?.permissions ?? []);
  const kaydedebilir =
    yetkiler.has(Permission.PAYMENT_CREATE) || yetkiler.has(Permission.COLLECTION_RECORD);
  const sahaTahsilati = yetkiler.has(Permission.COLLECTION_RECORD);
  const onaylayabilir = yetkiler.has(Permission.COMPANY_MANAGE);

  const [yontem, setYontem] = useState<PaymentMethod>(PaymentMethod.BANK_TRANSFER);
  const [tutar, setTutar] = useState('');
  const [bayiId, setBayiId] = useState('');
  const [referans, setReferans] = useState('');
  const [not, setNot] = useState('');

  const [tahsilatlar, setTahsilatlar] = useState<PaymentView[]>([]);
  const [toplamTutar, setToplamTutar] = useState(0);
  const [yalnizcaBenim, setYalnizcaBenim] = useState(false);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [kaydediliyor, setKaydediliyor] = useState(false);
  const [hata, setHata] = useState<string | null>(null);
  const [bilgi, setBilgi] = useState<string | null>(null);
  const [iptalGerekceleri, setIptalGerekceleri] = useState<Record<string, string>>({});
  const [kartAcik, setKartAcik] = useState(false);
  const [taksit, setTaksit] = useState(1);
  const [bankayaGidiliyor, setBankayaGidiliyor] = useState(false);

  /* Bankadan donuste sonuc sorgu dizesinde gelir; kullanici bu sayfaya
     yonlendirilir ve ne oldugunu OKUYARAK anlar. */
  const sorgu = useSearchParams();
  const donusSonucu = sorgu.get('sonuc');

  /* Anahtar yalnizca basarili kayittan SONRA tazelenir - basarisiz denemede
     ayni anahtarla tekrar denemek dogru davranistir. */
  const islemAnahtari = useRef<string | null>(null);

  const listele = useCallback(async () => {
    setYukleniyor(true);

    try {
      const sayfa = await financeApi.payments({
        onlyMine: yalnizcaBenim || undefined,
        limit: 25,
      });
      setTahsilatlar(sayfa.payments);
      setToplamTutar(sayfa.totalAmount);
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Tahsilatlar yüklenemedi.');
    } finally {
      setYukleniyor(false);
    }
  }, [yalnizcaBenim]);

  useEffect(() => {
    void listele();
  }, [listele]);

  useEffect(() => {
    /* Kart ile odeme yapilandirilmamissa dugme HIC cizilmez. Gorunen ama her
       denemede hata veren bir dugme, kullaniciyi bankasini aramaya yoneltir. */
    if (!yetkiler.has(Permission.PAYMENT_CREATE)) return;

    posApi
      .availability()
      .then(({ enabled }) => setKartAcik(enabled))
      .catch(() => setKartAcik(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function kaydet(olay: React.FormEvent) {
    olay.preventDefault();
    setHata(null);
    setBilgi(null);

    const sayisalTutar = Number(tutar.replace(',', '.'));

    if (!Number.isFinite(sayisalTutar) || sayisalTutar <= 0) {
      setHata('Tutar sıfırdan büyük bir sayı olmalıdır.');
      return;
    }

    if (sahaTahsilati && bayiId.trim().length === 0) {
      setHata('Saha tahsilatında bayi seçimi zorunludur.');
      return;
    }

    islemAnahtari.current ??= crypto.randomUUID();
    setKaydediliyor(true);

    try {
      const kayit = await financeApi.recordPayment(
        {
          method: yontem,
          amount: sayisalTutar,
          companyId: sahaTahsilati ? bayiId.trim() : undefined,
          reference: referans.trim() || undefined,
          note: not.trim() || undefined,
        },
        islemAnahtari.current,
      );

      islemAnahtari.current = null;
      setTutar('');
      setReferans('');
      setNot('');
      setBilgi(
        kayit.status === PaymentStatus.CONFIRMED
          ? `${para(kayit.amount, kayit.currency)} tutarındaki tahsilat işlendi; cari bakiyeniz güncellendi.`
          : `${para(kayit.amount, kayit.currency)} tutarındaki tahsilat kaydedildi. Muhasebe onayından sonra bakiyenize yansıyacaktır.`,
      );
      await listele();
    } catch (error) {
      setHata(
        error instanceof ApiError || error instanceof Error
          ? error.message
          : 'Tahsilat kaydedilemedi.',
      );
    } finally {
      setKaydediliyor(false);
    }
  }

  async function onayla(paymentId: string) {
    setHata(null);

    try {
      await financeApi.confirmPayment(paymentId);
      await listele();
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Tahsilat onaylanamadı.');
    }
  }

  async function iptalEt(paymentId: string) {
    const gerekce = (iptalGerekceleri[paymentId] ?? '').trim();

    if (gerekce.length < 3) {
      setHata('İptal gerekçesi zorunludur; denetim kaydına yazılır ve silinemez.');
      return;
    }

    setHata(null);

    try {
      await financeApi.cancelPayment(paymentId, gerekce);
      setIptalGerekceleri((oncekiler) => {
        const sonraki = { ...oncekiler };
        delete sonraki[paymentId];
        return sonraki;
      });
      await listele();
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Tahsilat iptal edilemedi.');
    }
  }

  /**
   * Kart ile odeme: sunucudan banka formunu alir ve tarayiciyi bankaya
   * GONDERIR. Form alanlari gizli input olarak basilir; kart bilgisi bu
   * sayfada HIC istenmez, kullanici kartini bankanin sayfasina girer.
   */
  async function kartIleOde() {
    const sayisalTutar = Number(tutar.replace(',', '.'));

    if (!Number.isFinite(sayisalTutar) || sayisalTutar <= 0) {
      setHata('Tutar sıfırdan büyük bir sayı olmalıdır.');
      return;
    }

    setHata(null);
    setBankayaGidiliyor(true);

    try {
      const form = await posApi.start({ amount: sayisalTutar, installment: taksit });

      const gizliForm = document.createElement('form');
      gizliForm.method = 'POST';
      gizliForm.action = form.actionUrl;

      for (const [ad, deger] of Object.entries(form.fields)) {
        const alan = document.createElement('input');
        alan.type = 'hidden';
        alan.name = ad;
        alan.value = deger;
        gizliForm.appendChild(alan);
      }

      document.body.appendChild(gizliForm);
      gizliForm.submit();
    } catch (error) {
      setBankayaGidiliyor(false);
      setHata(error instanceof Error ? error.message : 'Kart ile ödeme başlatılamadı.');
    }
  }

  const anindaIsler = SELF_CONFIRMING_METHODS.includes(yontem);

  return (
    <div>
      <div className="sayfa-baslik">
        <div>
          <h2>{sahaTahsilati ? 'Saha Tahsilatı' : 'Ödeme Yap'}</h2>
          <p>
            {sahaTahsilati
              ? 'Bayiden aldığınız tahsilatı kaydedin; nakit ve çek muhasebe onayına düşer.'
              : 'Ödemenizi bildirin, açık belgelerinize en eski vadeden başlayarak uygulansın.'}
          </p>
        </div>
      </div>

      {donusSonucu === 'basarili' && (
        <div className="uyari-kutu bilgi">
          Kart ödemeniz alındı ve cari hesabınıza işlendi.
        </div>
      )}

      {donusSonucu === 'hata' && (
        <div className="uyari-kutu hata">
          Kart ödemesi tamamlanamadı. Kartınızdan tutar çekilmediyse yeniden
          deneyebilirsiniz.
        </div>
      )}

      {donusSonucu === 'inceleme' && (
        <div className="uyari-kutu dikkat">
          <strong>Ödemeniz bankada onaylandı ancak hesabınıza işlenemedi.</strong> Kayıt
          incelemeye alındı; <strong>yeniden ödeme yapmayın</strong>. Muhasebe sizinle
          iletişime geçecektir.
        </div>
      )}

      {hata && <div className="uyari-kutu hata">{hata}</div>}
      {bilgi && <div className="uyari-kutu bilgi">{bilgi}</div>}

      {kaydedebilir && (
        <form className="toplam-kutu" style={{ maxWidth: 560 }} onSubmit={kaydet}>
          {sahaTahsilati && (
            <label className="alan">
              <span className="alan-etiket">Bayi Kimliği</span>
              <input
                className="alan-girdi"
                value={bayiId}
                onChange={(olay) => setBayiId(olay.target.value)}
                placeholder="Bayi listesinden kopyalanan kimlik"
                autoComplete="off"
              />
            </label>
          )}

          <label className="alan">
            <span className="alan-etiket">Ödeme Yöntemi</span>
            <select
              className="secim"
              style={{ width: '100%' }}
              value={yontem}
              onChange={(olay) => setYontem(olay.target.value as PaymentMethod)}
            >
              {Object.entries(PAYMENT_METHOD_LABELS).map(([deger, etiket]) => (
                <option key={deger} value={deger}>
                  {etiket}
                </option>
              ))}
            </select>
          </label>

          <label className="alan">
            <span className="alan-etiket">Tutar</span>
            <input
              className="alan-girdi"
              inputMode="decimal"
              value={tutar}
              onChange={(olay) => setTutar(olay.target.value)}
              placeholder="0,00"
              autoComplete="off"
            />
          </label>

          <label className="alan">
            <span className="alan-etiket">Referans (dekont / çek numarası)</span>
            <input
              className="alan-girdi"
              value={referans}
              onChange={(olay) => setReferans(olay.target.value)}
              maxLength={64}
              autoComplete="off"
            />
          </label>

          <label className="alan">
            <span className="alan-etiket">Not</span>
            <input
              className="alan-girdi"
              value={not}
              onChange={(olay) => setNot(olay.target.value)}
              maxLength={280}
              autoComplete="off"
            />
          </label>

          <div className="uyari-kutu bilgi" style={{ marginTop: 0 }}>
            {anindaIsler
              ? 'Bu yöntemde tahsilat anında işlenir ve açık belgelerinize en eski vadeden başlayarak dağıtılır.'
              : 'Fiziksel teslim gerektiren bu yöntemde kayıt onay bekler; bakiyeye ancak muhasebe doğruladıktan sonra işlenir.'}
          </div>

          <button className="dugme" type="submit" disabled={kaydediliyor}>
            {kaydediliyor ? 'Kaydediliyor…' : 'Tahsilatı Kaydet'}
          </button>

          {kartAcik && (
            <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--kenarlik)' }}>
              <p className="olcum-etiket">Kart ile Anında Öde</p>
              <p className="urun-alt" style={{ marginBottom: 12 }}>
                Yukarıdaki tutar için bankanızın 3D Secure sayfasına yönlendirilirsiniz.
                Kart bilgileriniz portalde <strong>istenmez ve saklanmaz</strong>.
              </p>

              <label className="alan">
                <span className="alan-etiket">Taksit</span>
                <select
                  className="secim"
                  style={{ width: '100%' }}
                  value={taksit}
                  onChange={(olay) => setTaksit(Number(olay.target.value))}
                >
                  <option value={1}>Tek Çekim</option>
                  {[2, 3, 6].map((adet) => (
                    <option key={adet} value={adet}>
                      {adet} Taksit
                    </option>
                  ))}
                </select>
              </label>

              <button
                className="dugme dugme-ikincil"
                type="button"
                disabled={bankayaGidiliyor}
                onClick={() => void kartIleOde()}
              >
                {bankayaGidiliyor ? 'Bankaya yönlendiriliyorsunuz…' : 'Kart ile Öde'}
              </button>
            </div>
          )}
        </form>
      )}

      <div className="sayfa-baslik" style={{ marginTop: 26 }}>
        <div>
          <h2 style={{ fontSize: 19 }}>Tahsilat Kayıtları</h2>
          <p>
            Listelenen {tahsilatlar.length} kayıt · Toplam {para(toplamTutar) ?? '—'}
          </p>
        </div>
      </div>

      {sahaTahsilati && (
        <div className="arac-cubugu">
          <label className="onay-etiket">
            <input
              type="checkbox"
              checked={yalnizcaBenim}
              onChange={(olay) => setYalnizcaBenim(olay.target.checked)}
            />
            Yalnızca benim topladıklarım (kasa mutabakatı)
          </label>
        </div>
      )}

      {tahsilatlar.length === 0 && !yukleniyor ? (
        <div className="bos-durum">Kayıtlı tahsilat bulunmuyor.</div>
      ) : (
        <div className="liste">
          <div className="liste-satir baslik">
            <span>Tahsilat</span>
            <span>Durum</span>
            <span>Tutar</span>
            <span style={{ textAlign: 'right' }}>İşlem</span>
          </div>

          {tahsilatlar.map((tahsilat) => (
            <div className="liste-satir" key={tahsilat.id}>
              <div>
                <p className="urun-ad">
                  {tahsilat.methodLabel}
                  {tahsilat.reference ? ` · ${tahsilat.reference}` : ''}
                </p>
                <p className="urun-alt">
                  {tahsilat.companyTitle} · {tarihSaat(tahsilat.receivedAt)} ·{' '}
                  {tahsilat.recordedByName}
                  {tahsilat.isFieldCollection ? ' · saha' : ''}
                </p>
                {tahsilat.allocations.length > 0 && (
                  <p className="urun-alt">
                    Kapatılan belgeler:{' '}
                    {tahsilat.allocations.map((dagitim) => dagitim.documentNumber).join(', ')}
                    {tahsilat.unallocatedAmount > 0
                      ? ` · Avans: ${para(tahsilat.unallocatedAmount, tahsilat.currency)}`
                      : ''}
                  </p>
                )}
              </div>

              <span className={`stok ${DURUM_SINIF[tahsilat.status]}`}>
                {tahsilat.statusLabel}
              </span>

              <div>
                <span className="fiyat">{para(tahsilat.amount, tahsilat.currency) ?? '—'}</span>
              </div>

              <div className="satir-eylem">
                {onaylayabilir && tahsilat.status === PaymentStatus.PENDING && (
                  <>
                    {/* Gerekce satirin icinde durur: iptal eden kisi kaydi
                        gorurken yazar, hatirladigini degil gordugunu anlatir. */}
                    <input
                      className="alan-girdi"
                      style={{ minWidth: 150, flex: '1 1 150px' }}
                      value={iptalGerekceleri[tahsilat.id] ?? ''}
                      onChange={(olay) =>
                        setIptalGerekceleri((oncekiler) => ({
                          ...oncekiler,
                          [tahsilat.id]: olay.target.value,
                        }))
                      }
                      placeholder="İptal gerekçesi"
                      maxLength={280}
                    />
                    <button
                      type="button"
                      className="dugme dugme-kucuk"
                      onClick={() => void onayla(tahsilat.id)}
                    >
                      Onayla
                    </button>
                    <button
                      type="button"
                      className="dugme dugme-ikincil dugme-kucuk"
                      onClick={() => void iptalEt(tahsilat.id)}
                    >
                      İptal
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
