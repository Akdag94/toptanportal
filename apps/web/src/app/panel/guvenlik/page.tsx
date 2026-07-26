'use client';

/**
 * Hesap Guvenligi
 *
 * Iki adimli dogrulama ISTEGE BAGLIDIR: kullanici ilk giriste kurmaya
 * zorlanmaz, dilerse buradan etkinlestirir. Bir kez etkinlestirildikten sonra
 * her giriste kod istenir - kapatma islemi bilincli olarak yoktur; guvenligi
 * dusuren bir degisiklik tek tikla yapilabilmemelidir.
 *
 * Kurtarma kodlari YALNIZCA kurulum aninda bir kez gosterilir; sunucu bunlarin
 * yalnizca ozetini saklar.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ActiveSession } from '@toptanportal/contracts';

import { authApi } from '../../../lib/api-client';
import { tarihSaat } from '../../../lib/bicim';
import { useSession } from '../../../lib/session-context';

type Asama =
  | { tur: 'DURUM' }
  | { tur: 'KURULUM'; secret: string; qrCodeDataUrl: string }
  | { tur: 'KURTARMA_KODLARI'; codes: string[] };

const PLATFORM_ADI: Record<ActiveSession['platform'], string> = {
  WEB: 'Web tarayıcı',
  IOS: 'iPhone / iPad',
  ANDROID: 'Android',
};

export default function GuvenlikSayfasi() {
  const { user, reload } = useSession();

  const [asama, setAsama] = useState<Asama>({ tur: 'DURUM' });
  const [kod, setKod] = useState('');
  const [oturumlar, setOturumlar] = useState<ActiveSession[]>([]);
  const [islemde, setIslemde] = useState(false);
  const [hata, setHata] = useState<string | null>(null);
  const [bildirim, setBildirim] = useState<string | null>(null);

  const oturumlariYukle = useCallback(async () => {
    try {
      const cevap = await authApi.sessions();
      setOturumlar(cevap.sessions);
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Oturumlar yüklenemedi.');
    }
  }, []);

  useEffect(() => {
    void oturumlariYukle();
  }, [oturumlariYukle]);

  async function kurulumuBaslat(): Promise<void> {
    setIslemde(true);
    setHata(null);
    setBildirim(null);

    try {
      const kurulum = await authApi.setupMfa();
      setAsama({
        tur: 'KURULUM',
        secret: kurulum.secret,
        qrCodeDataUrl: kurulum.qrCodeDataUrl,
      });
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Kurulum başlatılamadı.');
    } finally {
      setIslemde(false);
    }
  }

  async function kurulumuTamamla(): Promise<void> {
    setIslemde(true);
    setHata(null);

    try {
      const sonuc = await authApi.confirmSetupMfa(kod);
      setKod('');
      setAsama({ tur: 'KURTARMA_KODLARI', codes: sonuc.recoveryCodes });
      await reload();
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Kod doğrulanamadı.');
    } finally {
      setIslemde(false);
    }
  }

  async function oturumuKapat(oturum: ActiveSession): Promise<void> {
    setIslemde(true);
    setHata(null);

    try {
      await authApi.revokeSession(oturum.id);
      setBildirim(`${oturum.deviceName} cihazındaki oturum sonlandırıldı.`);
      await oturumlariYukle();
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Oturum sonlandırılamadı.');
    } finally {
      setIslemde(false);
    }
  }

  if (!user) return null;

  return (
    <div>
      <div className="sayfa-baslik">
        <div>
          <h2>Hesap Güvenliği</h2>
          <p>
            İki adımlı doğrulama zorunlu değildir. Etkinleştirirseniz her girişte kimlik
            doğrulayıcı uygulamanızdaki kod istenir.
          </p>
        </div>
      </div>

      {hata && <div className="uyari-kutu hata">{hata}</div>}
      {bildirim && <div className="uyari-kutu bilgi">{bildirim}</div>}

      {/* --- İki adımlı doğrulama --- */}

      <section className="toplam-kutu" style={{ marginBottom: 22, minWidth: 0 }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 16 }}>İki Adımlı Doğrulama</h3>

        {user.mfaEnrolled ? (
          <>
            <p className="urun-alt" style={{ marginBottom: 12 }}>
              <span className="stok var">Etkin</span>
            </p>
            <p className="urun-alt">
              Hesabınız kimlik doğrulayıcı uygulamayla korunuyor. Telefonunuza
              erişemiyorsanız kurulum sırasında aldığınız kurtarma kodlarından birini
              kullanabilirsiniz.
            </p>
          </>
        ) : asama.tur === 'DURUM' ? (
          <>
            <p className="urun-alt" style={{ marginBottom: 12 }}>
              <span className="stok yok">Kapalı</span>
            </p>
            <p className="urun-alt" style={{ marginBottom: 14 }}>
              Şifreniz ele geçse bile hesabınıza girilmesini engeller. Google
              Authenticator, Microsoft Authenticator veya iOS Şifreler uygulamasıyla
              çalışır.
            </p>
            <button
              type="button"
              className="dugme dugme-kucuk"
              disabled={islemde}
              onClick={() => void kurulumuBaslat()}
            >
              {islemde ? 'Hazırlanıyor…' : 'İki Adımlı Doğrulamayı Aç'}
            </button>
          </>
        ) : asama.tur === 'KURULUM' ? (
          <>
            <div className="uyari-kutu bilgi">
              Kimlik doğrulayıcı uygulamanızla aşağıdaki kodu okutun, ardından uygulamadaki
              6 haneli kodu girin.
            </div>

            <div className="qr-kutu">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={asama.qrCodeDataUrl}
                alt="İki adımlı doğrulama QR kodu"
                width={200}
                height={200}
              />
            </div>

            <div className="gizli-anahtar">{asama.secret}</div>

            <label className="alan">
              <span className="alan-etiket">Uygulamadaki 6 haneli kod</span>
              <input
                className="alan-girdi kod-girdi"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={kod}
                onChange={(olay) => setKod(olay.target.value.replace(/\D/g, ''))}
              />
            </label>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="dugme dugme-kucuk"
                disabled={islemde || kod.length !== 6}
                onClick={() => void kurulumuTamamla()}
              >
                {islemde ? 'Doğrulanıyor…' : 'Doğrula ve Etkinleştir'}
              </button>
              <button
                type="button"
                className="dugme dugme-ikincil dugme-kucuk"
                disabled={islemde}
                onClick={() => {
                  setKod('');
                  setAsama({ tur: 'DURUM' });
                }}
              >
                Vazgeç
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="uyari-kutu dikkat">
              Bu kodlar bir daha gösterilmeyecektir. Telefonunuza erişemediğinizde hesabınıza
              girmenizi sağlar; her kod yalnızca bir kez kullanılabilir.
            </div>

            <ul className="kurtarma-listesi">
              {asama.codes.map((code) => (
                <li key={code}>{code}</li>
              ))}
            </ul>

            <button
              type="button"
              className="dugme dugme-kucuk"
              onClick={() => setAsama({ tur: 'DURUM' })}
            >
              Kodları Kaydettim
            </button>
          </>
        )}
      </section>

      {/* --- Açık oturumlar --- */}

      <div className="sayfa-baslik">
        <div>
          <h2 style={{ fontSize: 18 }}>Açık Oturumlar</h2>
          <p>Tanımadığınız bir cihaz görüyorsanız oturumu sonlandırın ve şifrenizi değiştirin.</p>
        </div>
      </div>

      {oturumlar.length === 0 ? (
        <div className="bos-durum">Açık oturum bilgisi alınamadı.</div>
      ) : (
        <div className="liste">
          <div className="liste-satir baslik">
            <span>Cihaz</span>
            <span>Konum</span>
            <span>Son kullanım</span>
            <span style={{ textAlign: 'right' }}>İşlem</span>
          </div>

          {oturumlar.map((oturum) => (
            <div className="liste-satir" key={oturum.id}>
              <div>
                <p className="urun-ad">
                  {oturum.deviceName}
                  {oturum.current && (
                    <span className="iskonto-etiket" style={{ marginLeft: 8 }}>
                      Bu cihaz
                    </span>
                  )}
                </p>
                <p className="urun-alt">{PLATFORM_ADI[oturum.platform]}</p>
              </div>

              <span className="urun-alt">
                {oturum.city ? `${oturum.city} · ` : ''}
                {oturum.ip}
              </span>

              <span className="urun-alt">{tarihSaat(oturum.lastUsedAt)}</span>

              <div className="satir-eylem">
                {!oturum.current && (
                  <button
                    type="button"
                    className="dugme dugme-ikincil dugme-kucuk"
                    disabled={islemde}
                    onClick={() => void oturumuKapat(oturum)}
                  >
                    Oturumu Sonlandır
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
