'use client';

/**
 * Bildirim Gönderim Kaydı
 *
 * Bu ekran tek bir soruyu cevaplar: "bu kişiye gitti mi?" Tahsilat görüşmesi
 * bu soruyla başlar ve cevabı "göndermiş olmalıyız" olamaz.
 *
 * Üst şeritteki iki sayı SÜZGEÇTEN BAĞIMSIZDIR. Bir konuyu süzerken kuyrukta
 * bekleyen veya gönderilemeyen mesajların görünmez olması, sorunu süzgecin
 * arkasına saklar — ve gönderilemeyen bildirim, fark edilene kadar sessizdir.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  CHANNEL_LABELS,
  NotificationStatus,
  NotificationTopic,
  STATUS_LABELS,
  TOPIC_LABELS,
  type NotificationMessage,
  type NotificationPage,
} from '@toptanportal/contracts';

import { notificationApi } from '../../../lib/api-client';
import { tarihSaat } from '../../../lib/bicim';

const DURUM_SINIF: Record<string, string> = {
  SENT: 'var',
  PENDING: 'kritik',
  FAILED: 'yok',
  SUPPRESSED: 'kritik',
};

export default function BildirimKaydiSayfasi() {
  const [sayfa, setSayfa] = useState<NotificationPage | null>(null);
  const [kayitlar, setKayitlar] = useState<NotificationMessage[]>([]);

  const [konu, setKonu] = useState('');
  const [durum, setDurum] = useState('');
  const [arama, setArama] = useState('');
  const [uygulanan, setUygulanan] = useState<{ topic?: string; status?: string; q?: string }>({});

  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState<string | null>(null);

  const yukle = useCallback(
    async (ofset: number) => {
      setYukleniyor(true);
      setHata(null);

      try {
        const sonuc = await notificationApi.list({
          topic: uygulanan.topic as NotificationTopic | undefined,
          status: uygulanan.status as NotificationStatus | undefined,
          q: uygulanan.q,
          offset: ofset,
          limit: 50,
        });

        setSayfa(sonuc);
        setKayitlar((oncekiler) =>
          ofset === 0 ? sonuc.messages : [...oncekiler, ...sonuc.messages],
        );
      } catch (error) {
        setHata(error instanceof Error ? error.message : 'Bildirim kaydı okunamadı.');
      } finally {
        setYukleniyor(false);
      }
    },
    [uygulanan],
  );

  useEffect(() => {
    void yukle(0);
  }, [yukle]);

  return (
    <div>
      <div className="sayfa-baslik">
        <div>
          <h2>Bildirim Gönderim Kaydı</h2>
          <p>
            Gönderilmeyen bildirim de kaydedilir; sebebi satırın yanında yazar.
            Gönderilmiş bir bildirimin metni sonradan değiştirilemez.
          </p>
        </div>
      </div>

      {hata && <div className="uyari-kutu hata">{hata}</div>}

      {sayfa && sayfa.failedCount > 0 && (
        <div className="uyari-kutu hata">
          ⚠ {sayfa.failedCount} bildirim gönderilemedi ve deneme hakkı tükendi. Bu
          kişiler bilgilendirilmedi.
        </div>
      )}

      <div className="olcum-izgara">
        <article className="olcum">
          <p className="olcum-etiket">Kuyrukta Bekleyen</p>
          <p className="olcum-deger">{sayfa?.pendingCount ?? 0}</p>
          <p className="olcum-alt">Gönderim sırasını bekliyor</p>
        </article>

        <article className="olcum">
          <p className="olcum-etiket">Gönderilemeyen</p>
          <p className="olcum-deger">{sayfa?.failedCount ?? 0}</p>
          <p className="olcum-alt">Deneme hakkı tükendi, müdahale bekliyor</p>
        </article>

        <article className="olcum">
          <p className="olcum-etiket">Listelenen Kayıt</p>
          <p className="olcum-deger">{sayfa?.totalCount ?? 0}</p>
          <p className="olcum-alt">Bu ölçütlere uyan toplam kayıt</p>
        </article>
      </div>

      <form
        className="arac-cubugu"
        onSubmit={(olay) => {
          olay.preventDefault();
          setUygulanan({
            topic: konu || undefined,
            status: durum || undefined,
            q: arama.trim() || undefined,
          });
        }}
      >
        <select
          className="alan-girdi"
          style={{ maxWidth: 220 }}
          value={konu}
          onChange={(olay) => setKonu(olay.target.value)}
        >
          <option value="">Tüm konular</option>
          {Object.values(NotificationTopic).map((deger) => (
            <option key={deger} value={deger}>
              {TOPIC_LABELS[deger]}
            </option>
          ))}
        </select>

        <select
          className="alan-girdi"
          style={{ maxWidth: 180 }}
          value={durum}
          onChange={(olay) => setDurum(olay.target.value)}
        >
          <option value="">Tüm durumlar</option>
          {Object.values(NotificationStatus).map((deger) => (
            <option key={deger} value={deger}>
              {STATUS_LABELS[deger]}
            </option>
          ))}
        </select>

        <input
          className="alan-girdi"
          style={{ maxWidth: 240 }}
          value={arama}
          onChange={(olay) => setArama(olay.target.value)}
          placeholder="Alıcı veya konu satırı"
          autoComplete="off"
        />

        <button className="dugme dugme-kucuk" type="submit" disabled={yukleniyor}>
          {yukleniyor ? 'Aranıyor…' : 'Ara'}
        </button>
      </form>

      {kayitlar.length === 0 && !yukleniyor ? (
        <div className="bos-durum">Bu ölçütlere uyan bildirim bulunmuyor.</div>
      ) : (
        <div className="liste">
          {kayitlar.map((kayit) => (
            <div className="liste-satir" key={kayit.id}>
              <div>
                <p className="urun-ad">{kayit.subject}</p>
                <p className="urun-alt">
                  {kayit.recipientName ?? '—'} · {kayit.recipient}
                </p>
                <p className="urun-alt">
                  {TOPIC_LABELS[kayit.topic]} · {CHANNEL_LABELS[kayit.channel]} ·{' '}
                  {tarihSaat(kayit.createdAt)}
                  {kayit.sentAt ? ` · gönderim: ${tarihSaat(kayit.sentAt)}` : ''}
                </p>

                {/* Sebep, durumun kendisinden daha degerlidir: "gonderilmedi"
                    tek basina cevap degil, sorunun tekrari. */}
                {kayit.suppressedReason && (
                  <p className="urun-alt" style={{ opacity: 0.8 }}>
                    Sebep: {kayit.suppressedReason}
                  </p>
                )}

                {kayit.lastError && (
                  <p className="urun-alt" style={{ opacity: 0.8 }}>
                    Hata: {kayit.lastError}
                  </p>
                )}
              </div>

              <span className={`stok ${DURUM_SINIF[kayit.status] ?? 'kritik'}`}>
                {STATUS_LABELS[kayit.status]}
              </span>

              <span className="urun-alt">
                {kayit.attempts > 1 ? `${kayit.attempts} deneme` : ''}
              </span>

              <span />
            </div>
          ))}
        </div>
      )}

      {sayfa?.hasMore && (
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <button
            type="button"
            className="dugme dugme-ikincil dugme-kucuk"
            disabled={yukleniyor}
            onClick={() => void yukle(kayitlar.length)}
          >
            {yukleniyor
              ? 'Yükleniyor…'
              : `Daha Fazla Göster (${kayitlar.length} / ${sayfa.totalCount})`}
          </button>
        </div>
      )}
    </div>
  );
}
