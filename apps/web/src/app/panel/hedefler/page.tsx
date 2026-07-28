'use client';

/**
 * Hedef ve Prim
 *
 * Plasiyer kendi satırını görür, yönetici hepsini görür ve hedef tanımlar;
 * ayrımı sunucu yapar, arayüz yalnızca gelen veriyi çizer.
 *
 * PRİM HESABI EKRANDA AÇIKÇA GÖSTERİLİR: gerçekleşen ciro, tahsilat oranı ve
 * ikisinin çarpımı ayrı satırlarda durur. Primi tek bir rakam olarak vermek,
 * itiraz halinde "bu nereden çıktı" sorusunu cevaplayamaz — ve o soru her ay
 * sorulur.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SalesTarget } from '@toptanportal/contracts';

import { fieldApi } from '../../../lib/api-client';
import { para, yuzde } from '../../../lib/bicim';
import { useSession } from '../../../lib/session-context';

function bulunulanDonem(): string {
  const simdi = new Date();
  return `${simdi.getFullYear()}-${String(simdi.getMonth() + 1).padStart(2, '0')}`;
}

export default function HedeflerSayfasi() {
  const { user } = useSession();
  const [hedefler, setHedefler] = useState<SalesTarget[]>([]);
  const [donem, setDonem] = useState(bulunulanDonem());
  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState<string | null>(null);

  const yukle = useCallback(async () => {
    setYukleniyor(true);
    setHata(null);

    try {
      setHedefler(await fieldApi.targets({ period: donem }));
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Hedefler yüklenemedi.');
    } finally {
      setYukleniyor(false);
    }
  }, [donem]);

  useEffect(() => {
    void yukle();
  }, [yukle]);

  if (!user) return null;

  return (
    <div>
      <div className="sayfa-baslik">
        <div>
          <h2>Hedef ve Prim</h2>
          <p>
            Prim yalnızca hedef tutturulduğunda ve <strong>tahsil edilen tutar oranında</strong>{' '}
            hesaplanır. Satılıp tahsil edilemeyen ciro prime esas olmaz.
          </p>
        </div>
        <input
          className="alan-girdi"
          style={{ maxWidth: 160 }}
          type="month"
          value={donem}
          onChange={(olay) => setDonem(olay.target.value)}
        />
      </div>

      {hata && <div className="uyari-kutu hata">{hata}</div>}

      {hedefler.length === 0 && !yukleniyor ? (
        <div className="bos-durum">Bu dönem için tanımlı hedef bulunmuyor.</div>
      ) : (
        hedefler.map((hedef) => {
          const tutturuldu = hedef.achievementRate >= 100;

          return (
            <div key={hedef.id} style={{ marginBottom: 20 }}>
              <div className="olcum-izgara">
                <article className="olcum">
                  <p className="olcum-etiket">Hedef</p>
                  <p className="olcum-deger">
                    {para(hedef.targetAmount, hedef.currency) ?? '—'}
                  </p>
                  <p className="olcum-alt">
                    {hedef.salesRepName} · {hedef.period}
                  </p>
                </article>

                <article className="olcum">
                  <p className="olcum-etiket">Gerçekleşen</p>
                  <p className={`olcum-deger ${tutturuldu ? 'alacak' : 'borc'}`}>
                    {para(hedef.achievedAmount, hedef.currency) ?? '—'}
                  </p>
                  <p className="olcum-alt">
                    Gerçekleşme: {yuzde(hedef.achievementRate)}
                    {tutturuldu ? ' · hedef tuttu' : ' · hedefin altında'}
                  </p>
                </article>

                <article className="olcum">
                  <p className="olcum-etiket">Tahsil Edilen</p>
                  <p className="olcum-deger">
                    {para(hedef.collectedAmount, hedef.currency) ?? '—'}
                  </p>
                  <p className="olcum-alt">Tahsilat oranı: {yuzde(hedef.collectionRate)}</p>
                </article>

                <article className="olcum">
                  <p className="olcum-etiket">Hak Edilen Prim</p>
                  <p className={`olcum-deger ${hedef.commissionAmount > 0 ? 'alacak' : ''}`}>
                    {para(hedef.commissionAmount, hedef.currency) ?? '—'}
                  </p>
                  <p className="olcum-alt">
                    {tutturuldu
                      ? `${yuzde(hedef.commissionRate)} prim × ${yuzde(hedef.collectionRate)} tahsilat`
                      : 'Hedef tutturulmadığı için prim hesaplanmadı'}
                  </p>
                </article>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
