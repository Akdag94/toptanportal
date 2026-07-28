'use client';

/**
 * Bayilerim (Plasiyer Portföyü)
 *
 * Plasiyer sabah bu ekrana bakar ve üç soru sorar: kim borçlu, kimi uzun
 * süredir ziyaret etmedim, kim uzun süredir sipariş vermedi.
 *
 * Bu yüzden sıralama ünvana göre değil, ekrandaki SÜZGEÇLERE bırakılmıştır:
 * "60 gündür sipariş yok" listesi bir çalışma listesidir, alfabetik bir rehber
 * değil. Parasal alanlar sunucudan yetkiye göre gelir; gelmediğinde satır
 * çizilmez, sıfır GÖSTERİLMEZ.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { CompanyListItem } from '@toptanportal/contracts';

import { fieldApi } from '../../../lib/api-client';
import { gun, para } from '../../../lib/bicim';

const BOSTA_SECENEKLERI = [
  { etiket: 'Tümü', gun: undefined },
  { etiket: '30 gündür sipariş yok', gun: 30 },
  { etiket: '60 gündür sipariş yok', gun: 60 },
  { etiket: '90 gündür sipariş yok', gun: 90 },
];

export default function BayilerSayfasi() {
  const [bayiler, setBayiler] = useState<CompanyListItem[]>([]);
  const [toplam, setToplam] = useState(0);
  const [devamVar, setDevamVar] = useState(false);

  const [arama, setArama] = useState('');
  const [uygulananArama, setUygulananArama] = useState('');
  const [bostaGun, setBostaGun] = useState<number | undefined>(undefined);
  const [yalnizcaBorclu, setYalnizcaBorclu] = useState(false);

  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState<string | null>(null);

  const yukle = useCallback(
    async (ofset: number) => {
      setYukleniyor(true);
      setHata(null);

      try {
        const sayfa = await fieldApi.companies({
          q: uygulananArama || undefined,
          idleDays: bostaGun,
          onlyOverdue: yalnizcaBorclu || undefined,
          offset: ofset,
          limit: 25,
        });

        setToplam(sayfa.totalCount);
        setDevamVar(sayfa.hasMore);
        setBayiler((oncekiler) =>
          ofset === 0 ? sayfa.companies : [...oncekiler, ...sayfa.companies],
        );
      } catch (error) {
        setHata(error instanceof Error ? error.message : 'Bayiler yüklenemedi.');
      } finally {
        setYukleniyor(false);
      }
    },
    [uygulananArama, bostaGun, yalnizcaBorclu],
  );

  useEffect(() => {
    void yukle(0);
  }, [yukle]);

  return (
    <div>
      <div className="sayfa-baslik">
        <div>
          <h2>Bayilerim</h2>
          <p>{toplam} bayi portföyünüzde. Ziyaret notu eklemek için bayiye tıklayın.</p>
        </div>
      </div>

      {hata && <div className="uyari-kutu hata">{hata}</div>}

      <form
        className="arac-cubugu"
        onSubmit={(olay) => {
          olay.preventDefault();
          setUygulananArama(arama.trim());
        }}
      >
        <input
          className="alan-girdi"
          style={{ maxWidth: 260 }}
          value={arama}
          onChange={(olay) => setArama(olay.target.value)}
          placeholder="Ünvan veya cari kod"
          autoComplete="off"
        />

        <select
          className="secim"
          value={bostaGun ?? ''}
          onChange={(olay) =>
            setBostaGun(olay.target.value === '' ? undefined : Number(olay.target.value))
          }
        >
          {BOSTA_SECENEKLERI.map((secenek) => (
            <option key={secenek.etiket} value={secenek.gun ?? ''}>
              {secenek.etiket}
            </option>
          ))}
        </select>

        <label className="onay-etiket">
          <input
            type="checkbox"
            checked={yalnizcaBorclu}
            onChange={(olay) => setYalnizcaBorclu(olay.target.checked)}
          />
          Vadesi geçmiş borcu olanlar
        </label>

        <button className="dugme dugme-kucuk" type="submit" disabled={yukleniyor}>
          {yukleniyor ? 'Aranıyor…' : 'Ara'}
        </button>
      </form>

      {bayiler.length === 0 && !yukleniyor ? (
        <div className="bos-durum">Bu ölçütlere uyan bayi bulunmuyor.</div>
      ) : (
        <div className="liste">
          <div className="liste-satir baslik">
            <span>Bayi</span>
            <span>Durum</span>
            <span>Bakiye</span>
            <span style={{ textAlign: 'right' }}>Son Hareket</span>
          </div>

          {bayiler.map((bayi) => {
            const bakiye = para(bayi.balance, bayi.currency);
            const gecikmis = para(bayi.overdueAmount, bayi.currency);
            const aylik = para(bayi.monthlyOrderTotal, bayi.currency);

            return (
              <div className="liste-satir" key={bayi.id}>
                <div>
                  <p className="urun-ad">{bayi.title}</p>
                  <p className="urun-alt">
                    {bayi.logoCariCode}
                    {bayi.city ? ` · ${bayi.city}` : ''}
                    {bayi.district ? ` / ${bayi.district}` : ''}
                    {bayi.phone ? ` · ${bayi.phone}` : ''}
                  </p>
                  {aylik && <p className="urun-alt">Bu ay: {aylik}</p>}
                </div>

                <div>
                  {bayi.isBlocked ? (
                    <span className="stok yok">Sipariş Kapalı</span>
                  ) : bayi.overdueAmount !== undefined && bayi.overdueAmount > 0 ? (
                    <span className="stok kritik">Vadesi Geçmiş</span>
                  ) : (
                    <span className="stok var">Açık</span>
                  )}
                </div>

                <div>
                  {bakiye ? (
                    <>
                      <span className="fiyat">{bakiye}</span>
                      {gecikmis && bayi.overdueAmount !== undefined && bayi.overdueAmount > 0 && (
                        <p className="urun-alt" style={{ color: 'var(--hata)' }}>
                          Gecikmiş: {gecikmis}
                        </p>
                      )}
                    </>
                  ) : (
                    <span className="fiyat-alt">—</span>
                  )}
                </div>

                <div style={{ textAlign: 'right' }}>
                  <p className="urun-alt">Sipariş: {gun(bayi.lastOrderAt)}</p>
                  <p className="urun-alt">Ziyaret: {gun(bayi.lastVisitAt)}</p>
                  <p className="urun-alt" style={{ marginTop: 6 }}>
                    <Link href={`/panel/ziyaretler?bayi=${bayi.id}`}>Ziyaret notu ekle →</Link>
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {devamVar && (
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <button
            type="button"
            className="dugme dugme-ikincil dugme-kucuk"
            disabled={yukleniyor}
            onClick={() => void yukle(bayiler.length)}
          >
            {yukleniyor ? 'Yükleniyor…' : `Daha Fazla Göster (${bayiler.length} / ${toplam})`}
          </button>
        </div>
      )}
    </div>
  );
}
