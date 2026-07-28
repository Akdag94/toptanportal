'use client';

/**
 * Ziyaret Notları
 *
 * Ekranın en üstünde "takibi gecikmiş ziyaret" sayısı durur: plasiyerin güne
 * başlarken bakacağı tek sayı odur. Liste ikinci sıradadır çünkü geçmişi
 * okumak, bugünü planlamaktan sonra gelir.
 *
 * Not eklendikten sonra DEĞİŞTİRİLEMEZ — sunucu ve veritabanı bunu ayrı ayrı
 * uygular. Arayüz bu yüzden düzenleme düğmesi göstermez; gösterip sunucudan
 * hata almak, kullanıcıya olmayan bir yetenek vaat etmektir.
 */

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  VISIT_OUTCOME_LABELS,
  VisitOutcome,
  type CompanyListItem,
  type VisitNote,
} from '@toptanportal/contracts';

import { fieldApi } from '../../../lib/api-client';
import { gun, tarihSaat } from '../../../lib/bicim';

const SONUC_SINIF: Record<VisitOutcome, string> = {
  [VisitOutcome.ORDER_TAKEN]: 'var',
  [VisitOutcome.COLLECTION]: 'var',
  [VisitOutcome.INTRODUCTION]: 'kritik',
  [VisitOutcome.NO_ORDER]: 'kritik',
  [VisitOutcome.COMPLAINT]: 'yok',
};

export default function ZiyaretlerSayfasi() {
  const sorgu = useSearchParams();
  const secilenBayi = sorgu.get('bayi');

  const [notlar, setNotlar] = useState<VisitNote[]>([]);
  const [gecikmisTakip, setGecikmisTakip] = useState(0);
  const [bayiler, setBayiler] = useState<CompanyListItem[]>([]);
  const [yalnizcaGeciken, setYalnizcaGeciken] = useState(false);

  const [bayiId, setBayiId] = useState(secilenBayi ?? '');
  const [sonuc, setSonuc] = useState<VisitOutcome>(VisitOutcome.NO_ORDER);
  const [metin, setMetin] = useState('');
  const [takipTarihi, setTakipTarihi] = useState('');

  const [yukleniyor, setYukleniyor] = useState(true);
  const [kaydediliyor, setKaydediliyor] = useState(false);
  const [hata, setHata] = useState<string | null>(null);
  const [bildirim, setBildirim] = useState<string | null>(null);

  const yukle = useCallback(async () => {
    setYukleniyor(true);

    try {
      const sayfa = await fieldApi.visits({
        dueOnly: yalnizcaGeciken || undefined,
        limit: 50,
      });
      setNotlar(sayfa.notes);
      setGecikmisTakip(sayfa.overdueFollowUps);
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Ziyaret notları yüklenemedi.');
    } finally {
      setYukleniyor(false);
    }
  }, [yalnizcaGeciken]);

  useEffect(() => {
    void yukle();
  }, [yukle]);

  useEffect(() => {
    fieldApi
      .companies({ limit: 100 })
      .then((sayfa) => setBayiler(sayfa.companies))
      .catch(() => setBayiler([]));
  }, []);

  async function kaydet(olay: React.FormEvent) {
    olay.preventDefault();
    setHata(null);
    setBildirim(null);

    if (bayiId.length === 0) {
      setHata('Bayi seçin.');
      return;
    }

    if (metin.trim().length < 3) {
      setHata('Not en az 3 karakter olmalıdır.');
      return;
    }

    setKaydediliyor(true);

    try {
      const not = await fieldApi.createVisit({
        companyId: bayiId,
        outcome: sonuc,
        note: metin.trim(),
        followUpDate: takipTarihi || undefined,
      });

      setMetin('');
      setTakipTarihi('');
      setBildirim(`${not.companyTitle} ziyareti kaydedildi.`);
      await yukle();
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Ziyaret notu kaydedilemedi.');
    } finally {
      setKaydediliyor(false);
    }
  }

  return (
    <div>
      <div className="sayfa-baslik">
        <div>
          <h2>Ziyaret Notları</h2>
          <p>Notlar eklendikten sonra değiştirilemez; düzeltme yeni bir notla yapılır.</p>
        </div>
      </div>

      {gecikmisTakip > 0 && (
        <div className="uyari-kutu dikkat">
          <strong>{gecikmisTakip} ziyaretin takip tarihi geldi veya geçti.</strong> Günün iş
          listesi için &ldquo;Yalnızca takibi gelenler&rdquo; süzgecini kullanın.
        </div>
      )}

      {hata && <div className="uyari-kutu hata">{hata}</div>}
      {bildirim && <div className="uyari-kutu bilgi">{bildirim}</div>}

      <form className="toplam-kutu" style={{ maxWidth: 560 }} onSubmit={kaydet}>
        <label className="alan">
          <span className="alan-etiket">Bayi</span>
          <select
            className="secim"
            style={{ width: '100%' }}
            value={bayiId}
            onChange={(olay) => setBayiId(olay.target.value)}
          >
            <option value="">Seçin…</option>
            {bayiler.map((bayi) => (
              <option key={bayi.id} value={bayi.id}>
                {bayi.title}
              </option>
            ))}
          </select>
        </label>

        <label className="alan">
          <span className="alan-etiket">Ziyaret Sonucu</span>
          <select
            className="secim"
            style={{ width: '100%' }}
            value={sonuc}
            onChange={(olay) => setSonuc(olay.target.value as VisitOutcome)}
          >
            {Object.entries(VISIT_OUTCOME_LABELS).map(([deger, etiket]) => (
              <option key={deger} value={deger}>
                {etiket}
              </option>
            ))}
          </select>
        </label>

        <label className="alan">
          <span className="alan-etiket">Not</span>
          <textarea
            className="alan-girdi"
            style={{ minHeight: 90, resize: 'vertical' }}
            value={metin}
            onChange={(olay) => setMetin(olay.target.value)}
            maxLength={1000}
            placeholder="Görüşülen kişi, konuşulan konular, verilen sözler…"
          />
        </label>

        <label className="alan">
          <span className="alan-etiket">Takip Tarihi (isteğe bağlı)</span>
          <input
            className="alan-girdi"
            type="date"
            value={takipTarihi}
            onChange={(olay) => setTakipTarihi(olay.target.value)}
          />
        </label>

        <button className="dugme" type="submit" disabled={kaydediliyor}>
          {kaydediliyor ? 'Kaydediliyor…' : 'Ziyareti Kaydet'}
        </button>
      </form>

      <div className="arac-cubugu" style={{ marginTop: 22 }}>
        <label className="onay-etiket">
          <input
            type="checkbox"
            checked={yalnizcaGeciken}
            onChange={(olay) => setYalnizcaGeciken(olay.target.checked)}
          />
          Yalnızca takibi gelenler
        </label>
      </div>

      {notlar.length === 0 && !yukleniyor ? (
        <div className="bos-durum">Kayıtlı ziyaret notu bulunmuyor.</div>
      ) : (
        <div className="liste">
          {notlar.map((not) => (
            <div className="liste-satir" key={not.id}>
              <div>
                <p className="urun-ad">{not.companyTitle}</p>
                <p className="urun-alt">{not.note}</p>
                <p className="urun-alt">
                  {not.authorName} · {tarihSaat(not.visitedAt)}
                  {not.followUpDate ? ` · Takip: ${gun(not.followUpDate)}` : ''}
                </p>
              </div>

              <span className={`stok ${SONUC_SINIF[not.outcome]}`}>{not.outcomeLabel}</span>

              <span />
              <span />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
