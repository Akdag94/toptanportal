'use client';

/**
 * Bildirim Tercihleri
 *
 * Ekranın açık sözü şudur: hangi bildirimi alacağına kullanıcı karar verir —
 * yöneticisi değil. Bunun tek istisnası kilitli satırlardır ve kilit sebebi
 * satırın yanında YAZAR; gerekçesiz kilit, kullanıcıya "yapamazsın" demenin
 * en sinir bozucu biçimidir.
 *
 * Değişiklik anında kaydedilir. "Kaydet" düğmesi, tek bir anahtarı çevirip
 * sayfadan çıkan kullanıcının değişikliğini sessizce kaybettirir.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  CHANNEL_LABELS,
  MANDATORY_TOPICS,
  TOPIC_LABELS,
  type NotificationPreference,
  type NotificationPreferences,
} from '@toptanportal/contracts';

import { notificationApi } from '../../../lib/api-client';

/** Konu başına kısa açıklama — etiket tek başına ne zaman geleceğini anlatmaz. */
const KONU_ACIKLAMA: Record<string, string> = {
  ORDER_STATUS: 'Siparişiniz onaylandığında, reddedildiğinde veya iptal edildiğinde.',
  ORDER_APPROVAL_PENDING: 'Bir sipariş sizin onayınızı beklediğinde.',
  PAYMENT_RECEIVED: 'Ödemeniz hesabınıza işlendiğinde.',
  DUE_DATE_REMINDER: 'Bir belgenin vadesi yaklaştığında veya geçtiğinde.',
  SECURITY: 'Şifre değişikliği, yeni cihazdan giriş, hesap durumu değişikliği.',
  INTEGRATION_ALERT: 'Logo köprüsü koptuğunda veya işlenemeyen olay biriktiğinde.',
};

const KILIT_SEBEBI: Record<string, string> = {
  SECURITY:
    'Kapatılamaz: hesabınız ele geçirilirse bunu öğrenmenizin tek yolu bu bildirimdir.',
  ORDER_APPROVAL_PENDING:
    'Kapatılamaz: onayınızı bekleyen siparişin stoğu rezerve tutulur, bekleyen sipariş depoyu meşgul eder.',
};

export default function BildirimTercihleriSayfasi() {
  const [veri, setVeri] = useState<NotificationPreferences | null>(null);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [kaydedilen, setKaydedilen] = useState<string | null>(null);
  const [hata, setHata] = useState<string | null>(null);

  const yukle = useCallback(async () => {
    setYukleniyor(true);
    setHata(null);

    try {
      setVeri(await notificationApi.preferences());
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Tercihler okunamadı.');
    } finally {
      setYukleniyor(false);
    }
  }, []);

  useEffect(() => {
    void yukle();
  }, [yukle]);

  async function degistir(tercih: NotificationPreference, yeniDeger: boolean) {
    const anahtar = `${tercih.topic}:${tercih.channel}`;
    setKaydedilen(anahtar);
    setHata(null);

    /* Iyimser guncelleme: anahtar hemen doner. Sunucu reddederse yukleme
       gercek durumu geri getirir - kullanicinin bir anahtarin donmesini
       beklemesi, ayarlar ekraninda kabul edilebilir bir sey degildir. */
    setVeri((onceki) =>
      onceki
        ? {
            ...onceki,
            preferences: onceki.preferences.map((satir) =>
              satir.topic === tercih.topic && satir.channel === tercih.channel
                ? { ...satir, enabled: yeniDeger }
                : satir,
            ),
          }
        : onceki,
    );

    try {
      const sonuc = await notificationApi.updatePreferences({
        updates: [{ topic: tercih.topic, channel: tercih.channel, enabled: yeniDeger }],
      });
      setVeri(sonuc);
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Tercih kaydedilemedi.');
      await yukle();
    } finally {
      setKaydedilen(null);
    }
  }

  if (yukleniyor && !veri) {
    return <div className="yukleniyor">Yükleniyor…</div>;
  }

  const konular = [...new Set((veri?.preferences ?? []).map((satir) => satir.topic))];

  return (
    <div>
      <div className="sayfa-baslik">
        <div>
          <h2>Bildirim Tercihleri</h2>
          <p>
            Hangi bildirimi alacağınıza siz karar verirsiniz. Güvenlik ve onay
            bildirimleri kapatılamaz — sebepleri aşağıda yazılıdır.
          </p>
        </div>
      </div>

      {hata && <div className="uyari-kutu hata">{hata}</div>}

      <div className="olcum-izgara">
        <article className="olcum">
          <p className="olcum-etiket">E-posta Adresiniz</p>
          <p className="olcum-deger" style={{ fontSize: 16, wordBreak: 'break-all' }}>
            {veri?.email}
          </p>
          <p className="olcum-alt">Bildirimler bu adrese gönderilir.</p>
        </article>

        <article className="olcum">
          <p className="olcum-etiket">Mobil Cihaz</p>
          <p className="olcum-deger" style={{ fontSize: 16 }}>
            {veri?.hasPushDevice ? 'Kayıtlı' : 'Kayıtlı değil'}
          </p>
          <p className="olcum-alt">
            {veri?.hasPushDevice
              ? 'Mobil bildirimler uygulamaya gönderilir.'
              : 'Mobil bildirim için uygulamada oturum açmanız gerekir; bu satırlar açık olsa da gönderim yapılmaz.'}
          </p>
        </article>
      </div>

      <div className="liste">
        {konular.map((konu) => {
          const satirlar = (veri?.preferences ?? []).filter((satir) => satir.topic === konu);
          const kilitli = MANDATORY_TOPICS.includes(konu);

          return (
            <div className="liste-satir" key={konu}>
              <div>
                <p className="urun-ad">{TOPIC_LABELS[konu]}</p>
                <p className="urun-alt">{KONU_ACIKLAMA[konu]}</p>
                {kilitli && (
                  <p className="urun-alt" style={{ opacity: 0.75 }}>
                    {KILIT_SEBEBI[konu]}
                  </p>
                )}
              </div>

              <span />
              <span />

              <div className="satir-eylem" style={{ gap: 8 }}>
                {satirlar.map((satir) => (
                  <label
                    key={satir.channel}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}
                  >
                    <input
                      type="checkbox"
                      checked={satir.enabled}
                      disabled={satir.locked || kaydedilen === `${satir.topic}:${satir.channel}`}
                      onChange={(olay) => void degistir(satir, olay.target.checked)}
                    />
                    {CHANNEL_LABELS[satir.channel]}
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
