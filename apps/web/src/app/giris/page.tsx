'use client';

/**
 * ToptanPortal Web - Giris Ekrani
 *
 * Sunucunun dondugu `outcome` degerine gore ilerleyen bir adim makinesidir:
 *
 *   kimlik  --SUCCESS-------------------------> panel
 *           --MFA_REQUIRED------------------->  kod
 *           --MFA_ENROLLMENT_REQUIRED-------->  kayit -> kurtarma kodlari -> panel
 *           --PASSWORD_CHANGE_REQUIRED------->  sifre -> (gerekirse kod) -> panel
 *
 * Hicbir adim atlanamaz; her adim sunucu tarafindan uretilen kisa omurlu ve
 * tek kullanimlik bir jetona baglidir.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { LoginResponse, SessionUser, TokenPair } from '@toptanportal/contracts';

import { ApiError, NetworkError, authApi } from '../../lib/api-client';
import { useSession } from '../../lib/session-context';

type Adim =
  | { tur: 'KIMLIK' }
  | { tur: 'KOD'; challengeToken: string; maskedPhone: string | null }
  | { tur: 'KAYIT_BASLAT'; challengeToken: string }
  | {
      tur: 'KAYIT_ONAY';
      enrollmentToken: string;
      secret: string;
      qrCodeDataUrl: string;
    }
  | { tur: 'KURTARMA_KODLARI'; codes: string[] }
  | { tur: 'SIFRE_DEGISTIR'; challengeToken: string };

export default function GirisPage() {
  const router = useRouter();
  const { user, loading, signIn } = useSession();

  const [adim, setAdim] = useState<Adim>({ tur: 'KIMLIK' });
  const [hata, setHata] = useState<string | null>(null);
  const [alanHatalari, setAlanHatalari] = useState<Record<string, string[]>>({});
  const [gonderiliyor, setGonderiliyor] = useState(false);

  useEffect(() => {
    if (!loading && user) router.replace('/panel');
  }, [user, loading, router]);

  const hatayiIsle = useCallback((error: unknown) => {
    if (error instanceof ApiError) {
      setHata(error.message);
      setAlanHatalari(error.details ?? {});
      return;
    }
    if (error instanceof NetworkError) {
      setHata(error.message);
      setAlanHatalari({});
      return;
    }
    setHata('Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin.');
    setAlanHatalari({});
  }, []);

  const oturumuTamamla = useCallback(
    (tokens: TokenPair, sessionUser: SessionUser) => {
      signIn(tokens, sessionUser);
      router.replace('/panel');
    },
    [signIn, router],
  );

  const yanitiIsle = useCallback(
    async (yanit: LoginResponse) => {
      switch (yanit.outcome) {
        case 'SUCCESS':
          oturumuTamamla(yanit.tokens, yanit.user);
          return;

        case 'MFA_REQUIRED':
          setAdim({
            tur: 'KOD',
            challengeToken: yanit.challengeToken,
            maskedPhone: yanit.maskedPhone,
          });
          return;

        case 'MFA_ENROLLMENT_REQUIRED':
          setAdim({ tur: 'KAYIT_BASLAT', challengeToken: yanit.challengeToken });
          return;

        case 'PASSWORD_CHANGE_REQUIRED':
          setAdim({ tur: 'SIFRE_DEGISTIR', challengeToken: yanit.challengeToken });
          return;
      }
    },
    [oturumuTamamla],
  );

  /**
   * Zorunlu 2FA kaydi: challenge alinir alinmaz QR uretilir.
   *
   * Challenge jetonu SUNUCUDA TEK KULLANIMLIKTIR (tekrar saldirisi korumasi).
   * Bu yuzden istek jeton basina YALNIZCA BIR KEZ gonderilmelidir. React
   * StrictMode gelistirme ortaminda etkileri iki kez calistirir; ikinci istek
   * MFA_CHALLENGE_EXPIRED alir ve kullanici kayit adimina hic ulasamaz.
   *
   * Temizlemede istegi "iptal" saymak da yanlisti: sunucudaki jeton zaten
   * tuketilmis oluyor, dolayisiyla basarili yaniti atmak durumu kurtarmiyor,
   * tam tersine tek gecerli yaniti kaybettiriyordu.
   */
  const kayitIstegiGonderilen = useRef<string | null>(null);

  useEffect(() => {
    if (adim.tur !== 'KAYIT_BASLAT') return;

    const challengeToken = adim.challengeToken;

    if (kayitIstegiGonderilen.current === challengeToken) return;
    kayitIstegiGonderilen.current = challengeToken;

    void (async () => {
      try {
        const kayit = await authApi.startEnrollment(challengeToken);
        setAdim({
          tur: 'KAYIT_ONAY',
          enrollmentToken: kayit.enrollmentToken,
          secret: kayit.secret,
          qrCodeDataUrl: kayit.qrCodeDataUrl,
        });
      } catch (error) {
        // Jeton tukendigi icin bu challenge ile tekrar denenemez; kullanici
        // bastan giris yapmalidir.
        kayitIstegiGonderilen.current = null;
        hatayiIsle(error);
        setAdim({ tur: 'KIMLIK' });
      }
    })();
  }, [adim, hatayiIsle]);

  const gonder = useCallback(
    async (islem: () => Promise<void>) => {
      setGonderiliyor(true);
      setHata(null);
      setAlanHatalari({});
      try {
        await islem();
      } catch (error) {
        hatayiIsle(error);
      } finally {
        setGonderiliyor(false);
      }
    },
    [hatayiIsle],
  );

  if (loading) {
    return <div className="yukleniyor">Yükleniyor…</div>;
  }

  return (
    <main className="giris-sayfa">
      <div className="giris-kart">
        <h1 className="marka">ToptanPortal</h1>
        <p className="alt-baslik">{altBaslik(adim)}</p>

        {hata && (
          <div className="uyari-kutu hata" role="alert">
            {hata}
          </div>
        )}

        {adim.tur === 'KIMLIK' && (
          <KimlikFormu
            gonderiliyor={gonderiliyor}
            alanHatalari={alanHatalari}
            onGonder={(email, sifre, kiraciKodu) =>
              gonder(async () => {
                const yanit = await authApi.login(email, sifre, kiraciKodu);
                await yanitiIsle(yanit);
              })
            }
          />
        )}

        {adim.tur === 'KOD' && (
          <KodFormu
            maskedPhone={adim.maskedPhone}
            gonderiliyor={gonderiliyor}
            onGonder={(kod, cihaziHatirla) =>
              gonder(async () => {
                const yanit = await authApi.verifyMfa(
                  adim.challengeToken,
                  kod,
                  cihaziHatirla,
                );
                await yanitiIsle(yanit);
              })
            }
            onVazgec={() => setAdim({ tur: 'KIMLIK' })}
          />
        )}

        {adim.tur === 'KAYIT_BASLAT' && (
          <p className="alt-baslik">Doğrulama anahtarınız hazırlanıyor…</p>
        )}

        {adim.tur === 'KAYIT_ONAY' && (
          <KayitFormu
            secret={adim.secret}
            qrCodeDataUrl={adim.qrCodeDataUrl}
            gonderiliyor={gonderiliyor}
            onGonder={(kod) =>
              gonder(async () => {
                const sonuc = await authApi.confirmEnrollment(adim.enrollmentToken, kod);
                setTokensAfterEnrollment(sonuc.tokens, sonuc.user, signIn);
                setAdim({ tur: 'KURTARMA_KODLARI', codes: sonuc.recoveryCodes });
              })
            }
          />
        )}

        {adim.tur === 'KURTARMA_KODLARI' && (
          <KurtarmaKodlari codes={adim.codes} onDevam={() => router.replace('/panel')} />
        )}

        {adim.tur === 'SIFRE_DEGISTIR' && (
          <SifreFormu
            gonderiliyor={gonderiliyor}
            alanHatalari={alanHatalari}
            onGonder={(yeniSifre) =>
              gonder(async () => {
                const yanit = await authApi.forcedPasswordChange(
                  adim.challengeToken,
                  yeniSifre,
                );
                await yanitiIsle(yanit);
              })
            }
          />
        )}
      </div>
    </main>
  );
}

function setTokensAfterEnrollment(
  tokens: TokenPair,
  user: SessionUser,
  signIn: (tokens: TokenPair, user: SessionUser) => void,
): void {
  signIn(tokens, user);
}

function altBaslik(adim: Adim): string {
  switch (adim.tur) {
    case 'KIMLIK':
      return 'Hesabınıza giriş yapın.';
    case 'KOD':
      return 'İki adımlı doğrulama kodunu girin.';
    case 'KAYIT_BASLAT':
    case 'KAYIT_ONAY':
      return 'Hesabınız için iki adımlı doğrulama zorunludur.';
    case 'KURTARMA_KODLARI':
      return 'Kurtarma kodlarınızı güvenli bir yere kaydedin.';
    case 'SIFRE_DEGISTIR':
      return 'Devam etmek için şifrenizi değiştirin.';
  }
}

// ---------------------------------------------------------------------------
// Adim formlari
// ---------------------------------------------------------------------------

function KimlikFormu({
  gonderiliyor,
  alanHatalari,
  onGonder,
}: {
  gonderiliyor: boolean;
  alanHatalari: Record<string, string[]>;
  onGonder: (email: string, sifre: string, kiraciKodu?: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [sifre, setSifre] = useState('');
  const [kiraciKodu, setKiraciKodu] = useState('');

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onGonder(email, sifre, kiraciKodu.trim() || undefined);
      }}
      noValidate
    >
      <label className="alan">
        <span className="alan-etiket">E-posta</span>
        <input
          className="alan-girdi"
          type="email"
          name="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={Boolean(alanHatalari.email)}
        />
        {alanHatalari.email?.[0] && (
          <span className="alan-hata">{alanHatalari.email[0]}</span>
        )}
      </label>

      <label className="alan">
        <span className="alan-etiket">Şifre</span>
        <input
          className="alan-girdi"
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={sifre}
          onChange={(event) => setSifre(event.target.value)}
          aria-invalid={Boolean(alanHatalari.password)}
        />
        {alanHatalari.password?.[0] && (
          <span className="alan-hata">{alanHatalari.password[0]}</span>
        )}
      </label>

      <label className="alan">
        <span className="alan-etiket">Firma kodu (yalnızca gerekiyorsa)</span>
        <input
          className="alan-girdi"
          type="text"
          value={kiraciKodu}
          onChange={(event) => setKiraciKodu(event.target.value)}
          placeholder="Boş bırakabilirsiniz"
        />
      </label>

      <button className="dugme" type="submit" disabled={gonderiliyor}>
        {gonderiliyor ? 'Giriş yapılıyor…' : 'Giriş yap'}
      </button>
    </form>
  );
}

function KodFormu({
  maskedPhone,
  gonderiliyor,
  onGonder,
  onVazgec,
}: {
  maskedPhone: string | null;
  gonderiliyor: boolean;
  onGonder: (kod: string, cihaziHatirla: boolean) => void;
  onVazgec: () => void;
}) {
  const [kod, setKod] = useState('');
  const [cihaziHatirla, setCihaziHatirla] = useState(false);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onGonder(kod, cihaziHatirla);
      }}
      noValidate
    >
      {maskedPhone && (
        <div className="uyari-kutu bilgi">
          Kod {maskedPhone} numaralı telefona gönderildi.
        </div>
      )}

      <label className="alan">
        <span className="alan-etiket">Doğrulama kodu</span>
        <input
          className="alan-girdi kod-girdi"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          maxLength={20}
          required
          value={kod}
          onChange={(event) => setKod(event.target.value)}
        />
        <span className="alan-hata" style={{ color: 'var(--metin-ikincil)' }}>
          Kimlik doğrulayıcı uygulamanızdaki 6 haneli kodu veya bir kurtarma kodunu
          girebilirsiniz.
        </span>
      </label>

      <label className="onay-satir">
        <input
          type="checkbox"
          checked={cihaziHatirla}
          onChange={(event) => setCihaziHatirla(event.target.checked)}
        />
        Bu cihazı 30 gün hatırla
      </label>

      <button className="dugme" type="submit" disabled={gonderiliyor}>
        {gonderiliyor ? 'Doğrulanıyor…' : 'Doğrula'}
      </button>

      <button
        className="dugme dugme-ikincil"
        type="button"
        style={{ marginTop: 8 }}
        onClick={onVazgec}
      >
        Vazgeç
      </button>
    </form>
  );
}

function KayitFormu({
  secret,
  qrCodeDataUrl,
  gonderiliyor,
  onGonder,
}: {
  secret: string;
  qrCodeDataUrl: string;
  gonderiliyor: boolean;
  onGonder: (kod: string) => void;
}) {
  const [kod, setKod] = useState('');

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onGonder(kod);
      }}
      noValidate
    >
      <div className="uyari-kutu bilgi">
        Kimlik doğrulayıcı uygulamanızla (Google Authenticator, Microsoft
        Authenticator veya iOS Şifreler) aşağıdaki kodu okutun.
      </div>

      <div className="qr-kutu">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qrCodeDataUrl} alt="İki adımlı doğrulama QR kodu" width={200} height={200} />
      </div>

      <div className="gizli-anahtar">{secret}</div>

      <label className="alan">
        <span className="alan-etiket">Uygulamadaki 6 haneli kod</span>
        <input
          className="alan-girdi kod-girdi"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          required
          value={kod}
          onChange={(event) => setKod(event.target.value.replace(/\D/g, ''))}
        />
      </label>

      <button className="dugme" type="submit" disabled={gonderiliyor || kod.length !== 6}>
        {gonderiliyor ? 'Kaydediliyor…' : 'Doğrula ve tamamla'}
      </button>
    </form>
  );
}

function KurtarmaKodlari({ codes, onDevam }: { codes: string[]; onDevam: () => void }) {
  const [onaylandi, setOnaylandi] = useState(false);

  return (
    <div>
      <div className="uyari-kutu dikkat">
        Bu kodlar bir daha gösterilmeyecektir. Telefonunuza erişemediğiniz durumda
        hesabınıza girmenizi sağlar; her kod yalnızca bir kez kullanılabilir.
      </div>

      <ul className="kurtarma-listesi">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>

      <label className="onay-satir">
        <input
          type="checkbox"
          checked={onaylandi}
          onChange={(event) => setOnaylandi(event.target.checked)}
        />
        Kodları güvenli bir yere kaydettim
      </label>

      <button className="dugme" type="button" disabled={!onaylandi} onClick={onDevam}>
        Panele git
      </button>
    </div>
  );
}

function SifreFormu({
  gonderiliyor,
  alanHatalari,
  onGonder,
}: {
  gonderiliyor: boolean;
  alanHatalari: Record<string, string[]>;
  onGonder: (yeniSifre: string) => void;
}) {
  const [yeniSifre, setYeniSifre] = useState('');
  const [tekrar, setTekrar] = useState('');

  const eslesmiyor = tekrar.length > 0 && yeniSifre !== tekrar;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (eslesmiyor) return;
        onGonder(yeniSifre);
      }}
      noValidate
    >
      <div className="uyari-kutu dikkat">
        Şifreniz en az 10 karakter olmalı; büyük harf, küçük harf ve rakam içermelidir.
      </div>

      <label className="alan">
        <span className="alan-etiket">Yeni şifre</span>
        <input
          className="alan-girdi"
          type="password"
          autoComplete="new-password"
          required
          value={yeniSifre}
          onChange={(event) => setYeniSifre(event.target.value)}
          aria-invalid={Boolean(alanHatalari.newPassword)}
        />
        {alanHatalari.newPassword?.[0] && (
          <span className="alan-hata">{alanHatalari.newPassword[0]}</span>
        )}
      </label>

      <label className="alan">
        <span className="alan-etiket">Yeni şifre (tekrar)</span>
        <input
          className="alan-girdi"
          type="password"
          autoComplete="new-password"
          required
          value={tekrar}
          onChange={(event) => setTekrar(event.target.value)}
          aria-invalid={eslesmiyor}
        />
        {eslesmiyor && <span className="alan-hata">Şifreler eşleşmiyor.</span>}
      </label>

      <button
        className="dugme"
        type="submit"
        disabled={gonderiliyor || eslesmiyor || yeniSifre.length === 0}
      >
        {gonderiliyor ? 'Kaydediliyor…' : 'Şifreyi değiştir'}
      </button>
    </form>
  );
}
