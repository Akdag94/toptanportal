'use client';

/**
 * Yaslandirma Karti
 *
 * Kovalarin agirligi seritte GORELI cizilir: en buyuk kova serit genisligini
 * belirlemez, toplam acik tutar belirler. Boylece iki farkli bayinin serilerine
 * bakan plasiyer, ayni gorsel uzunlugu ayni orana karsilik getirir.
 *
 * Tutari sifir olan kova serite HIC girmez. Sifir genislikli bir dilim, olcek
 * hakkinda yanlis fikir verir; renkli bir tirnak gibi gorunur.
 */

import { AGING_BUCKETS, type AgingReport } from '@toptanportal/contracts';

import { para } from '../lib/bicim';

/** Kova sirasi sabittir; renk sinifi da sıradan turer (k0 en taze, k4 en eski). */
const KOVA_SIRASI = AGING_BUCKETS.map((kova) => kova.key);

interface Props {
  rapor: AgingReport;
  /** Baslik gizlenirse kart bir ust bileşenin icine gomulebilir. */
  baslik?: string;
}

export function YaslandirmaKarti({ rapor, baslik = 'Yaşlandırma' }: Props) {
  const toplam = rapor.buckets.reduce((toplam, kova) => toplam + Math.abs(kova.amount), 0);
  const dolu = rapor.buckets.filter((kova) => Math.abs(kova.amount) > 0);

  return (
    <section className="yaslandirma">
      <h3>{baslik}</h3>

      {dolu.length === 0 ? (
        <p className="olcum-alt" style={{ margin: 0 }}>
          Açık belgeniz bulunmuyor.
        </p>
      ) : (
        <>
          <div
            className="kova-serit"
            role="img"
            aria-label={`Açık bakiyenin vade dağılımı. Toplam ${para(rapor.totalOpen, rapor.currency) ?? ''}`}
          >
            {dolu.map((kova) => (
              <div
                key={kova.key}
                className={`kova-dilim k${KOVA_SIRASI.indexOf(kova.key)}`}
                style={{ flexGrow: Math.abs(kova.amount) / toplam }}
              />
            ))}
          </div>

          <ul className="kova-liste">
            {rapor.buckets.map((kova) => {
              const tutar = para(kova.amount, rapor.currency);

              return (
                <li className="kova-satir" key={kova.key}>
                  <span className={`kova-nokta k${KOVA_SIRASI.indexOf(kova.key)}`} />
                  <span>
                    {kova.label}
                    {kova.documentCount > 0 && (
                      <span className="olcum-alt"> · {kova.documentCount} belge</span>
                    )}
                  </span>
                  <span className="kova-tutar">{tutar ?? '—'}</span>
                </li>
              );
            })}
          </ul>

          {rapor.oldestOverdueDays > 0 && (
            <p className="olcum-alt" style={{ marginTop: 14 }}>
              En eski açık belgeniz <strong>{rapor.oldestOverdueDays} gündür</strong> vadesi
              geçmiş durumda.
            </p>
          )}
        </>
      )}
    </section>
  );
}
