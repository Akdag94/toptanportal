'use client';

/**
 * Logo Entegrasyon Yonetimi
 *
 * Ekranin tek amaci su soruyu tek bakista cevaplamaktir: "Logo ile arasi iyi
 * mi, degilse ne yapmam gerekiyor?"
 *
 * Bu yuzden en ustte SAYI degil YAS gosterilir. "142 olay bekliyor" tek basina
 * alarm degildir; gece calisan toplu is de bunu uretir. "En eski olay 40
 * dakikadir bekliyor" ise her zaman alarmdir ve rengi de oyle olur.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  BRIDGE_STATUS_LABELS,
  BridgeStatus,
  SYNC_CHANNEL_LABELS,
  SyncChannel,
  type DeadEventView,
  type IntegrationStatus,
} from '@toptanportal/contracts';

import { integrationApi } from '../../../lib/api-client';
import { tarihSaat } from '../../../lib/bicim';

const DURUM_SINIF: Record<BridgeStatus, string> = {
  [BridgeStatus.HEALTHY]: 'var',
  [BridgeStatus.DEGRADED]: 'kritik',
  [BridgeStatus.UNREACHABLE]: 'yok',
};

/** Bekleyen olayin alarm sayilacagi yas. Kuyruk normalde saniyeler icinde erir. */
const GECIKME_ESIGI_SANIYE = 900;

function sureMetni(saniye: number): string {
  if (saniye < 60) return `${saniye} saniye`;
  if (saniye < 3600) return `${Math.floor(saniye / 60)} dakika`;
  return `${Math.floor(saniye / 3600)} saat`;
}

export default function EntegrasyonSayfasi() {
  const [durum, setDurum] = useState<IntegrationStatus | null>(null);
  const [oluOlaylar, setOluOlaylar] = useState<DeadEventView[]>([]);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [islemde, setIslemde] = useState<string | null>(null);
  const [hata, setHata] = useState<string | null>(null);
  const [bildirim, setBildirim] = useState<string | null>(null);

  const yukle = useCallback(async () => {
    setYukleniyor(true);
    setHata(null);

    try {
      const [durumSonuc, oluSonuc] = await Promise.all([
        integrationApi.status(),
        integrationApi.deadEvents(),
      ]);

      setDurum(durumSonuc);
      setOluOlaylar(oluSonuc);
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Entegrasyon durumu okunamadı.');
    } finally {
      setYukleniyor(false);
    }
  }, []);

  useEffect(() => {
    void yukle();
  }, [yukle]);

  async function calistir(etiket: string, islem: () => Promise<void>) {
    setIslemde(etiket);
    setHata(null);
    setBildirim(null);

    try {
      await islem();
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'İşlem tamamlanamadı.');
    } finally {
      setIslemde(null);
    }
  }

  const yokla = () =>
    calistir('yoklama', async () => {
      setDurum(await integrationApi.probe());
      setBildirim('Köprü yoklandı.');
    });

  const senkronla = (channel: SyncChannel, fullResync: boolean) =>
    calistir(`${channel}-${fullResync}`, async () => {
      const sonuc = await integrationApi.sync(channel, fullResync);
      setBildirim(
        sonuc
          ? `${SYNC_CHANNEL_LABELS[channel]}: ${sonuc.itemCount} kayıt işlendi${sonuc.hasMore ? ' (devamı var)' : ''}.`
          : `${SYNC_CHANNEL_LABELS[channel]} kanalı şu anda başka bir turda çalışıyor veya kapalı.`,
      );
      await yukle();
    });

  const kanalDegistir = (channel: SyncChannel, enabled: boolean) =>
    calistir(`toggle-${channel}`, async () => {
      setDurum(await integrationApi.toggleChannel(channel, enabled));
    });

  const yenidenKuyruga = (eventIds?: string[]) =>
    calistir('retry', async () => {
      const { requeued } = await integrationApi.retryDeadEvents(eventIds);
      setBildirim(`${requeued} olay yeniden kuyruğa alındı.`);
      await yukle();
    });

  if (yukleniyor && !durum) {
    return <div className="yukleniyor">Yükleniyor…</div>;
  }

  if (!durum) {
    return <div className="uyari-kutu hata">{hata ?? 'Entegrasyon durumu okunamadı.'}</div>;
  }

  const gecikmeli =
    durum.oldestPendingSeconds !== null && durum.oldestPendingSeconds > GECIKME_ESIGI_SANIYE;

  return (
    <div>
      <div className="sayfa-baslik">
        <div>
          <h2>Logo Entegrasyonu</h2>
          <p>
            {durum.health
              ? `Son yoklama: ${tarihSaat(durum.health.checkedAt)}`
              : 'Henüz yoklama yapılmadı.'}
          </p>
        </div>
        <button
          type="button"
          className="dugme dugme-kucuk"
          disabled={islemde !== null}
          onClick={() => void yokla()}
        >
          {islemde === 'yoklama' ? 'Yoklanıyor…' : 'Şimdi Yokla'}
        </button>
      </div>

      {hata && <div className="uyari-kutu hata">{hata}</div>}
      {bildirim && <div className="uyari-kutu bilgi">{bildirim}</div>}

      {!durum.bridgeConfigured && (
        <div className="uyari-kutu dikkat">
          Köprü yapılandırılmamış (<code>LOGO_BRIDGE_BASE_URL</code> tanımsız). Siparişler
          kuyrukta birikir; portal çalışmaya devam eder ancak Logo’ya hiçbir aktarım yapılmaz.
        </div>
      )}

      {durum.deadEvents > 0 && (
        <div className="uyari-kutu hata">
          <strong>{durum.deadEvents} olay elle müdahale bekliyor.</strong> Bu siparişler
          Logo’ya İLETİLMEDİ. Eksik kartı Logo tarafında açtıktan sonra yeniden kuyruğa alın.
        </div>
      )}

      <div className="olcum-izgara">
        <article className="olcum">
          <p className="olcum-etiket">Köprü Durumu</p>
          <p className="olcum-deger">
            {durum.health ? (
              <span className={`stok ${DURUM_SINIF[durum.health.status]}`}>
                {BRIDGE_STATUS_LABELS[durum.health.status]}
              </span>
            ) : (
              '—'
            )}
          </p>
          <p className="olcum-alt">
            {durum.health
              ? `Logo servisi: ${durum.health.logoServiceUp ? 'açık' : 'kapalı'} · Veritabanı: ${
                  durum.health.databaseUp ? 'açık' : 'kapalı'
                }`
              : 'Köprü henüz yanıt vermedi.'}
          </p>
        </article>

        <article className="olcum">
          <p className="olcum-etiket">En Eski Bekleyen</p>
          <p className={`olcum-deger ${gecikmeli ? 'gecikmis' : ''}`}>
            {durum.oldestPendingSeconds === null
              ? 'Yok'
              : sureMetni(durum.oldestPendingSeconds)}
          </p>
          <p className="olcum-alt">{durum.pendingEvents} olay kuyrukta</p>
        </article>

        <article className="olcum">
          <p className="olcum-etiket">Ölü Olaylar</p>
          <p className={`olcum-deger ${durum.deadEvents > 0 ? 'gecikmis' : ''}`}>
            {durum.deadEvents}
          </p>
          <p className="olcum-alt">Deneme hakkı tükenmiş, operatör bekliyor</p>
        </article>

        <article className="olcum">
          <p className="olcum-etiket">Logo Firma / Dönem</p>
          <p className="olcum-deger">
            {durum.health ? `${durum.health.companyNumber} / ${durum.health.periodNumber}` : '—'}
          </p>
          <p className="olcum-alt">
            {durum.health?.version ? `Köprü sürümü: ${durum.health.version}` : 'Sürüm bilinmiyor'}
          </p>
        </article>
      </div>

      <div className="liste">
        <div className="liste-satir baslik">
          <span>Kanal</span>
          <span>Son Başarılı Tur</span>
          <span>Son Tur</span>
          <span style={{ textAlign: 'right' }}>İşlem</span>
        </div>

        {durum.channels.map((kanal) => (
          <div className="liste-satir" key={kanal.channel}>
            <div>
              <p className="urun-ad">{kanal.channelLabel}</p>
              <p className="urun-alt">
                {kanal.enabled ? 'Açık' : 'Kapalı'}
                {kanal.consecutiveFailures > 0
                  ? ` · ${kanal.consecutiveFailures} ardışık hata`
                  : ''}
              </p>
              {kanal.lastError && (
                <p className="urun-alt" style={{ color: 'var(--hata)' }}>
                  {kanal.lastError}
                </p>
              )}
            </div>

            <span className="urun-alt">
              {kanal.lastSuccessAt ? tarihSaat(kanal.lastSuccessAt) : 'Hiç'}
            </span>

            <span className="urun-alt">
              {kanal.lastAttemptAt ? tarihSaat(kanal.lastAttemptAt) : 'Hiç'} ·{' '}
              {kanal.lastItemCount} kayıt
            </span>

            <div className="satir-eylem">
              <button
                type="button"
                className="dugme dugme-kucuk"
                disabled={islemde !== null || !kanal.enabled}
                onClick={() => void senkronla(kanal.channel, false)}
              >
                {islemde === `${kanal.channel}-false` ? 'Çalışıyor…' : 'Şimdi Çalıştır'}
              </button>

              {/* Tam senkron imleci sifirlar ve saatler surebilir; ikincil
                  gorunumde durur ki yanlislikla tiklanmasin. */}
              <button
                type="button"
                className="dugme dugme-ikincil dugme-kucuk"
                disabled={islemde !== null || !kanal.enabled}
                onClick={() => void senkronla(kanal.channel, true)}
                title="İmleci sıfırlar ve tüm kayıtları baştan okur. Pahalıdır."
              >
                Tam Senkron
              </button>

              <button
                type="button"
                className="dugme dugme-ikincil dugme-kucuk"
                disabled={islemde !== null}
                onClick={() => void kanalDegistir(kanal.channel, !kanal.enabled)}
              >
                {kanal.enabled ? 'Kapat' : 'Aç'}
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="sayfa-baslik" style={{ marginTop: 26 }}>
        <div>
          <h2 style={{ fontSize: 19 }}>Elle Müdahale Bekleyenler</h2>
          <p>Deneme hakkı tükenen olaylar. Sorunu giderdikten sonra yeniden kuyruğa alın.</p>
        </div>
        {oluOlaylar.length > 0 && (
          <button
            type="button"
            className="dugme dugme-kucuk"
            disabled={islemde !== null}
            onClick={() => void yenidenKuyruga()}
          >
            {islemde === 'retry' ? 'Alınıyor…' : 'Tümünü Yeniden Kuyruğa Al'}
          </button>
        )}
      </div>

      {oluOlaylar.length === 0 ? (
        <div className="bos-durum">Müdahale bekleyen olay yok.</div>
      ) : (
        <div className="liste">
          {oluOlaylar.map((olay) => (
            <div className="liste-satir" key={olay.id}>
              <div>
                <p className="urun-ad">{olay.label ?? olay.aggregateId}</p>
                <p className="urun-alt">
                  {olay.eventType} · {olay.attempts} deneme · {tarihSaat(olay.createdAt)}
                </p>
                {olay.lastError && (
                  <p className="urun-alt" style={{ color: 'var(--hata)' }}>
                    {olay.lastError}
                  </p>
                )}
              </div>

              <span />
              <span />

              <div className="satir-eylem">
                <button
                  type="button"
                  className="dugme dugme-ikincil dugme-kucuk"
                  disabled={islemde !== null}
                  onClick={() => void yenidenKuyruga([olay.id])}
                >
                  Yeniden Dene
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
