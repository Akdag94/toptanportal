'use client';

/**
 * Kullanıcı Yönetimi
 *
 * GEÇİCİ ŞİFRE YALNIZCA BİR KEZ GÖSTERİLİR ve ekranda kalıcı olarak durur —
 * bir "kopyala" düğmesiyle birlikte. Sunucu onu bir daha vermez; kapatılınca
 * kaybolan bir bildirim, yöneticinin kullanıcıyı yeniden davet etmesine yol
 * açar ve o da eski kaydı çöpe çevirir.
 *
 * Harcama limiti alt kullanıcıya gösterilmez — Kör Sipariş Modundaki hesap
 * tutar görmez, dolayısıyla limitini de göremez. Limit aşıldığında sipariş
 * "onay bekliyor" durumuna düşer ve kullanıcı yalnızca bunu görür.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ROLE_LABELS,
  UserRole,
  type InviteUserResult,
  type ManagedUser,
} from '@toptanportal/contracts';

import { userApi } from '../../../lib/api-client';
import { para, tarihSaat } from '../../../lib/bicim';
import { useSession } from '../../../lib/session-context';

const DURUM_SINIF: Record<string, string> = {
  ACTIVE: 'var',
  INVITED: 'kritik',
  SUSPENDED: 'yok',
  LOCKED: 'yok',
};

export default function KullanicilarSayfasi() {
  const { user } = useSession();

  const [kullanicilar, setKullanicilar] = useState<ManagedUser[]>([]);
  const [toplam, setToplam] = useState(0);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState<string | null>(null);
  const [davet, setDavet] = useState<InviteUserResult | null>(null);

  const [eposta, setEposta] = useState('');
  const [adSoyad, setAdSoyad] = useState('');
  const [rol, setRol] = useState<UserRole>(UserRole.BUSINESS_STAFF);
  const [davetEdiliyor, setDavetEdiliyor] = useState(false);

  const [limitAcik, setLimitAcik] = useState<string | null>(null);
  const [siparisLimiti, setSiparisLimiti] = useState('');
  const [aylikLimit, setAylikLimit] = useState('');
  const [hepOnay, setHepOnay] = useState(true);

  const yukle = useCallback(async () => {
    setYukleniyor(true);
    setHata(null);

    try {
      const sayfa = await userApi.list({ limit: 100 });
      setKullanicilar(sayfa.users);
      setToplam(sayfa.totalCount);
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Kullanıcılar yüklenemedi.');
    } finally {
      setYukleniyor(false);
    }
  }, []);

  useEffect(() => {
    void yukle();
  }, [yukle]);

  async function davetEt(olay: React.FormEvent) {
    olay.preventDefault();
    setHata(null);
    setDavetEdiliyor(true);

    try {
      const sonuc = await userApi.invite({
        email: eposta.trim(),
        fullName: adSoyad.trim(),
        role: rol,
      });

      setDavet(sonuc);
      setEposta('');
      setAdSoyad('');
      await yukle();
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Kullanıcı davet edilemedi.');
    } finally {
      setDavetEdiliyor(false);
    }
  }

  async function durumDegistir(hedef: ManagedUser) {
    setHata(null);

    try {
      await userApi.setStatus(hedef.id, hedef.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE');
      await yukle();
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Durum değiştirilemedi.');
    }
  }

  async function limitKaydet(hedef: ManagedUser) {
    setHata(null);

    const sayi = (metin: string): number | null => {
      const temiz = metin.trim().replace(',', '.');
      if (temiz.length === 0) return null;
      const deger = Number(temiz);
      return Number.isFinite(deger) ? deger : null;
    };

    try {
      await userApi.setSpendingLimit(hedef.id, {
        perOrderLimit: sayi(siparisLimiti),
        monthlyLimit: sayi(aylikLimit),
        alwaysRequiresApproval: hepOnay,
      });

      setLimitAcik(null);
      await yukle();
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Limit kaydedilemedi.');
    }
  }

  if (!user) return null;

  return (
    <div>
      <div className="sayfa-baslik">
        <div>
          <h2>Kullanıcılar</h2>
          <p>{toplam} kullanıcı. Davet edilen kullanıcı ilk girişte kendi şifresini belirler.</p>
        </div>
      </div>

      {hata && <div className="uyari-kutu hata">{hata}</div>}

      {davet && (
        <div className="uyari-kutu bilgi">
          <strong>{davet.user.fullName}</strong> davet edildi. Tek kullanımlık şifre{' '}
          <strong>yalnızca şimdi</strong> görüntülenir:
          <div
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'center',
              marginTop: 10,
              flexWrap: 'wrap',
            }}
          >
            <code
              style={{
                padding: '8px 12px',
                fontSize: 15,
                letterSpacing: '0.05em',
                background: 'rgba(255,255,255,0.08)',
                borderRadius: 8,
              }}
            >
              {davet.temporaryPassword}
            </code>
            <button
              type="button"
              className="dugme dugme-ikincil dugme-kucuk"
              onClick={() => void navigator.clipboard.writeText(davet.temporaryPassword)}
            >
              Kopyala
            </button>
            <button
              type="button"
              className="dugme dugme-ikincil dugme-kucuk"
              onClick={() => setDavet(null)}
            >
              Kapat
            </button>
          </div>
        </div>
      )}

      <form className="toplam-kutu" style={{ maxWidth: 560 }} onSubmit={davetEt}>
        <label className="alan">
          <span className="alan-etiket">Ad Soyad</span>
          <input
            className="alan-girdi"
            value={adSoyad}
            onChange={(olay) => setAdSoyad(olay.target.value)}
            autoComplete="off"
          />
        </label>

        <label className="alan">
          <span className="alan-etiket">E-posta</span>
          <input
            className="alan-girdi"
            type="email"
            value={eposta}
            onChange={(olay) => setEposta(olay.target.value)}
            autoComplete="off"
          />
        </label>

        <label className="alan">
          <span className="alan-etiket">Rol</span>
          <select
            className="secim"
            style={{ width: '100%' }}
            value={rol}
            onChange={(olay) => setRol(olay.target.value as UserRole)}
          >
            {Object.entries(ROLE_LABELS).map(([deger, etiket]) => (
              <option key={deger} value={deger}>
                {etiket}
              </option>
            ))}
          </select>
        </label>

        <button className="dugme" type="submit" disabled={davetEdiliyor}>
          {davetEdiliyor ? 'Davet ediliyor…' : 'Kullanıcı Davet Et'}
        </button>
      </form>

      {kullanicilar.length === 0 && !yukleniyor ? (
        <div className="bos-durum">Kullanıcı bulunmuyor.</div>
      ) : (
        <div className="liste" style={{ marginTop: 22 }}>
          <div className="liste-satir baslik">
            <span>Kullanıcı</span>
            <span>Durum</span>
            <span>Limit</span>
            <span style={{ textAlign: 'right' }}>İşlem</span>
          </div>

          {kullanicilar.map((kisi) => (
            <div className="liste-satir" key={kisi.id}>
              <div>
                <p className="urun-ad">{kisi.fullName}</p>
                <p className="urun-alt">
                  {kisi.email} · {kisi.roleLabel}
                  {kisi.companyTitle ? ` · ${kisi.companyTitle}` : ''}
                </p>
                <p className="urun-alt">
                  {kisi.mfaEnrolled ? '2FA etkin' : '2FA tanımsız'} · Son giriş:{' '}
                  {kisi.lastLoginAt ? tarihSaat(kisi.lastLoginAt) : 'hiç'}
                </p>

                {limitAcik === kisi.id && (
                  <div style={{ marginTop: 12, display: 'grid', gap: 8, maxWidth: 320 }}>
                    <input
                      className="alan-girdi"
                      value={siparisLimiti}
                      onChange={(olay) => setSiparisLimiti(olay.target.value)}
                      placeholder="Sipariş başına limit (boş = sınırsız)"
                      inputMode="decimal"
                    />
                    <input
                      className="alan-girdi"
                      value={aylikLimit}
                      onChange={(olay) => setAylikLimit(olay.target.value)}
                      placeholder="Aylık limit (boş = sınırsız)"
                      inputMode="decimal"
                    />
                    <label className="onay-etiket">
                      <input
                        type="checkbox"
                        checked={hepOnay}
                        onChange={(olay) => setHepOnay(olay.target.checked)}
                      />
                      Tutar ne olursa olsun onaya düşsün
                    </label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        className="dugme dugme-kucuk"
                        onClick={() => void limitKaydet(kisi)}
                      >
                        Kaydet
                      </button>
                      <button
                        type="button"
                        className="dugme dugme-ikincil dugme-kucuk"
                        onClick={() => setLimitAcik(null)}
                      >
                        Vazgeç
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <span className={`stok ${DURUM_SINIF[kisi.status] ?? 'kritik'}`}>
                {kisi.status === 'ACTIVE'
                  ? 'Etkin'
                  : kisi.status === 'INVITED'
                    ? 'Davet Edildi'
                    : kisi.status === 'SUSPENDED'
                      ? 'Askıda'
                      : 'Kilitli'}
              </span>

              <div>
                {kisi.alwaysRequiresApproval ? (
                  <span className="urun-alt">Her sipariş onaya düşer</span>
                ) : kisi.perOrderLimit !== null ? (
                  <span className="urun-alt">
                    Sipariş: {para(kisi.perOrderLimit)}
                    {kisi.monthlyLimit !== null ? ` · Aylık: ${para(kisi.monthlyLimit)}` : ''}
                  </span>
                ) : (
                  <span className="urun-alt">Limitsiz</span>
                )}
              </div>

              <div className="satir-eylem">
                {kisi.role === UserRole.BUSINESS_STAFF && (
                  <button
                    type="button"
                    className="dugme dugme-ikincil dugme-kucuk"
                    onClick={() => {
                      setLimitAcik(limitAcik === kisi.id ? null : kisi.id);
                      setSiparisLimiti(kisi.perOrderLimit?.toString() ?? '');
                      setAylikLimit(kisi.monthlyLimit?.toString() ?? '');
                      setHepOnay(kisi.alwaysRequiresApproval);
                    }}
                  >
                    Limit
                  </button>
                )}

                {kisi.id !== user.id && (
                  <button
                    type="button"
                    className="dugme dugme-ikincil dugme-kucuk"
                    onClick={() => void durumDegistir(kisi)}
                  >
                    {kisi.status === 'ACTIVE' ? 'Askıya Al' : 'Etkinleştir'}
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
