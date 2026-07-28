'use client';

/**
 * Denetim Kayıtları
 *
 * Bu ekran bir GÖZETİM aracı değil, delil sunum aracıdır. Bu yüzden en üstte
 * zincirin son halkası (sıra numarası + özet) durur: delil sunan kişi,
 * ekrandaki kayıtların hangi zincir noktasına kadar doğrulandığını bilmelidir.
 *
 * Kayıtlar sıra numarasına göre listelenir, zamana göre değil — aynı
 * mikrosaniyede yazılan iki kaydın sırası zamanla belirlenemez ve delilde
 * sıra, zincirin kendisidir.
 */

import { useCallback, useEffect, useState } from 'react';
import type { AuditEntry, AuditPage, AuditVerifyResult } from '@toptanportal/contracts';

import { auditApi } from '../../../lib/api-client';
import { tarihSaat } from '../../../lib/bicim';

const SONUC_SINIF: Record<string, string> = {
  SUCCESS: 'var',
  FAILURE: 'yok',
  DENIED: 'kritik',
};

export default function DenetimSayfasi() {
  const [sayfa, setSayfa] = useState<AuditPage | null>(null);
  const [kayitlar, setKayitlar] = useState<AuditEntry[]>([]);
  const [dogrulama, setDogrulama] = useState<AuditVerifyResult | null>(null);

  const [aksiyon, setAksiyon] = useState('');
  const [eposta, setEposta] = useState('');
  const [uygulanan, setUygulanan] = useState<{ action?: string; actorEmail?: string }>({});

  const [yukleniyor, setYukleniyor] = useState(true);
  const [dogrulaniyor, setDogrulaniyor] = useState(false);
  const [hata, setHata] = useState<string | null>(null);
  const [acikKayit, setAcikKayit] = useState<string | null>(null);

  const yukle = useCallback(
    async (ofset: number) => {
      setYukleniyor(true);
      setHata(null);

      try {
        const sonuc = await auditApi.list({
          action: uygulanan.action,
          actorEmail: uygulanan.actorEmail,
          offset: ofset,
          limit: 50,
        });

        setSayfa(sonuc);
        setKayitlar((oncekiler) =>
          ofset === 0 ? sonuc.entries : [...oncekiler, ...sonuc.entries],
        );
      } catch (error) {
        setHata(error instanceof Error ? error.message : 'Denetim kayıtları okunamadı.');
      } finally {
        setYukleniyor(false);
      }
    },
    [uygulanan],
  );

  useEffect(() => {
    void yukle(0);
  }, [yukle]);

  async function zinciriDogrula() {
    setDogrulaniyor(true);
    setHata(null);

    try {
      setDogrulama(await auditApi.verify());
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Zincir doğrulanamadı.');
    } finally {
      setDogrulaniyor(false);
    }
  }

  return (
    <div>
      <div className="sayfa-baslik">
        <div>
          <h2>Denetim Kayıtları</h2>
          <p>
            Kayıtlar eklenir, asla değiştirilmez veya silinmez — veritabanı
            tetikleyicisiyle korunur. Her kayıt bir öncekinin özetini taşır.
          </p>
        </div>
        <button
          type="button"
          className="dugme dugme-kucuk"
          disabled={dogrulaniyor}
          onClick={() => void zinciriDogrula()}
        >
          {dogrulaniyor ? 'Doğrulanıyor…' : 'Zinciri Doğrula'}
        </button>
      </div>

      {hata && <div className="uyari-kutu hata">{hata}</div>}

      {dogrulama && (
        <div className={`uyari-kutu ${dogrulama.valid ? 'bilgi' : 'hata'}`}>
          {dogrulama.valid ? '✓ ' : '⚠ '}
          {dogrulama.message}
          {dogrulama.brokenAtSeq && (
            <>
              {' '}
              <strong>Kırılma noktası: #{dogrulama.brokenAtSeq}</strong>
            </>
          )}
        </div>
      )}

      {sayfa?.chainHead && (
        <div className="olcum-izgara">
          <article className="olcum">
            <p className="olcum-etiket">Zincirin Son Halkası</p>
            <p className="olcum-deger">#{sayfa.chainHead.lastSeq}</p>
            <p className="olcum-alt" style={{ wordBreak: 'break-all', fontSize: 11 }}>
              {sayfa.chainHead.lastHash}
            </p>
          </article>

          <article className="olcum">
            <p className="olcum-etiket">Listelenen Kayıt</p>
            <p className="olcum-deger">{sayfa.totalCount}</p>
            <p className="olcum-alt">Bu ölçütlere uyan toplam kayıt</p>
          </article>
        </div>
      )}

      <form
        className="arac-cubugu"
        onSubmit={(olay) => {
          olay.preventDefault();
          setUygulanan({
            action: aksiyon.trim() || undefined,
            actorEmail: eposta.trim() || undefined,
          });
        }}
      >
        <input
          className="alan-girdi"
          style={{ maxWidth: 240 }}
          value={aksiyon}
          onChange={(olay) => setAksiyon(olay.target.value)}
          placeholder="Aksiyon (order.placed)"
          autoComplete="off"
        />
        <input
          className="alan-girdi"
          style={{ maxWidth: 240 }}
          value={eposta}
          onChange={(olay) => setEposta(olay.target.value)}
          placeholder="Kullanıcı e-postası"
          autoComplete="off"
        />
        <button className="dugme dugme-kucuk" type="submit" disabled={yukleniyor}>
          {yukleniyor ? 'Aranıyor…' : 'Ara'}
        </button>
      </form>

      {kayitlar.length === 0 && !yukleniyor ? (
        <div className="bos-durum">Bu ölçütlere uyan kayıt bulunmuyor.</div>
      ) : (
        <div className="liste">
          {kayitlar.map((kayit) => (
            <div className="liste-satir" key={kayit.id}>
              <div>
                <p className="urun-ad">
                  #{kayit.seq} · {kayit.actionLabel}
                </p>
                <p className="urun-alt">
                  {kayit.actorEmail ?? kayit.actorType} · {tarihSaat(kayit.occurredAt)}
                  {kayit.ip ? ` · ${kayit.ip}` : ''}
                </p>
                {kayit.resourceType && (
                  <p className="urun-alt">
                    {kayit.resourceType}
                    {kayit.resourceId ? ` · ${kayit.resourceId}` : ''}
                  </p>
                )}

                {acikKayit === kayit.id && (
                  <pre
                    style={{
                      marginTop: 10,
                      padding: 12,
                      fontSize: 12,
                      overflowX: 'auto',
                      background: 'rgba(255,255,255,0.05)',
                      borderRadius: 10,
                    }}
                  >
                    {JSON.stringify(kayit.payload, null, 2)}
                    {'\n\nhash: '}
                    {kayit.hash}
                  </pre>
                )}
              </div>

              <span className={`stok ${SONUC_SINIF[kayit.outcome] ?? 'kritik'}`}>
                {kayit.outcome}
              </span>

              <span />

              <div className="satir-eylem">
                <button
                  type="button"
                  className="dugme dugme-ikincil dugme-kucuk"
                  onClick={() => setAcikKayit(acikKayit === kayit.id ? null : kayit.id)}
                >
                  {acikKayit === kayit.id ? 'Gizle' : 'Ayrıntı'}
                </button>
              </div>
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
