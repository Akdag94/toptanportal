'use client';

/**
 * Bildirim Metinleri
 *
 * Bu ekranda yazılan cümleler, portalin bayiye verdiği sözün kelimeleridir:
 * "siparişiniz onaylandı" mesajı gitmezse bayi telefona sarılır. Bu yüzden
 * ekran iki şeyi ısrarla görünür kılar:
 *
 *  1. VARSAYILAN metin her zaman görünür durur. Kiracı metni silmek zorunda
 *     kalmadan neyi değiştirdiğini görebilmelidir; "eskisi neydi" sorusu bir
 *     kaydetme işleminden sonra sorulur ve o an cevapsız kalmamalıdır.
 *  2. ÖNİZLEME İKİ SÜRÜMLÜDÜR. Kör Sipariş Modundaki bayinin ne alacağını
 *     görmeden şablon yazmak, tutarın sızıp sızmadığını gerçek bir bildirim
 *     gittikten sonra öğrenmektir. Kural bir uyarı metni değil, GÖRÜLEN bir
 *     şeydir: iki sürüm yan yana durur.
 *
 * Önizleme kaydetmez; kaydetme ise doğrulamayı sunucuda tekrar geçer.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  unknownPlaceholders,
  type NotificationChannel,
  type NotificationTemplateList,
  type NotificationTemplatePreviewResult,
  type NotificationTemplateView,
  type NotificationTopic,
} from '@toptanportal/contracts';

import { notificationApi } from '../../../lib/api-client';

function anahtar(satir: { topic: string; channel: string }): string {
  return `${satir.topic}:${satir.channel}`;
}

export default function BildirimMetinleriSayfasi() {
  const [veri, setVeri] = useState<NotificationTemplateList | null>(null);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState<string | null>(null);

  const [acikSatir, setAcikSatir] = useState<string | null>(null);
  const [konu, setKonu] = useState('');
  const [govde, setGovde] = useState('');
  const [onizleme, setOnizleme] = useState<NotificationTemplatePreviewResult | null>(null);
  const [islemde, setIslemde] = useState(false);

  const yukle = useCallback(async () => {
    setYukleniyor(true);
    setHata(null);

    try {
      setVeri(await notificationApi.templates());
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Şablonlar okunamadı.');
    } finally {
      setYukleniyor(false);
    }
  }, []);

  useEffect(() => {
    void yukle();
  }, [yukle]);

  const acik = useMemo(
    () => veri?.templates.find((satir) => anahtar(satir) === acikSatir) ?? null,
    [veri, acikSatir],
  );

  /* Bilinmeyen degisken KAYDETMEDEN once gosterilir. Sunucu da reddeder;
     ancak hatayi kaydetme aninda ogrenmek, uzun bir metni yazip gonderdikten
     sonra basa donmek demektir. */
  const bilinmeyen = useMemo(() => {
    if (!acik) return [] as string[];

    return [
      ...new Set([
        ...unknownPlaceholders(acik.topic, konu),
        ...unknownPlaceholders(acik.topic, govde),
      ]),
    ];
  }, [acik, konu, govde]);

  function ac(satir: NotificationTemplateView) {
    setAcikSatir(anahtar(satir));
    setKonu(satir.subjectTemplate ?? satir.defaultSubject);
    setGovde(satir.bodyTemplate ?? satir.defaultBody);
    setOnizleme(null);
    setHata(null);
  }

  function kapat() {
    setAcikSatir(null);
    setOnizleme(null);
  }

  function degiskenEkle(ad: string) {
    setGovde((onceki) => `${onceki}{{${ad}}}`);
  }

  async function onizle() {
    if (!acik) return;

    setIslemde(true);
    setHata(null);

    try {
      setOnizleme(
        await notificationApi.previewTemplate({
          topic: acik.topic,
          channel: acik.channel,
          subjectTemplate: konu,
          bodyTemplate: govde,
        }),
      );
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Önizleme üretilemedi.');
    } finally {
      setIslemde(false);
    }
  }

  async function kaydet() {
    if (!acik) return;

    setIslemde(true);
    setHata(null);

    try {
      setVeri(
        await notificationApi.saveTemplate({
          topic: acik.topic,
          channel: acik.channel,
          subjectTemplate: konu,
          bodyTemplate: govde,
        }),
      );
      kapat();
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Şablon kaydedilemedi.');
    } finally {
      setIslemde(false);
    }
  }

  async function varsayilanaDon(topic: NotificationTopic, channel: NotificationChannel) {
    setIslemde(true);
    setHata(null);

    try {
      setVeri(await notificationApi.resetTemplate(topic, channel));
      kapat();
    } catch (error) {
      setHata(error instanceof Error ? error.message : 'Şablon sıfırlanamadı.');
    } finally {
      setIslemde(false);
    }
  }

  if (yukleniyor && !veri) {
    return <div className="yukleniyor">Yükleniyor…</div>;
  }

  const konular = [...new Set((veri?.templates ?? []).map((satir) => satir.topic))];

  return (
    <div>
      <div className="sayfa-baslik">
        <div>
          <h2>Bildirim Metinleri</h2>
          <p>
            Bayilere giden bildirimlerin metnini burada değiştirirsiniz. Değiştirmediğiniz
            metinler varsayılan haliyle gönderilir; “varsayılana dön” satırı siler, kopyalamaz —
            böylece metin ileride iyileştirildiğinde siz de o iyileştirmeyi alırsınız.
          </p>
        </div>
      </div>

      {hata && <div className="uyari-kutu hata">{hata}</div>}

      <div className="uyari-kutu bilgi">
        Fiyat görmeyen kullanıcıya (Kör Sipariş Modu) giden metinden parasal değerler
        <strong> düşürülür</strong>: değeri üretilmeyen bir değişkeni içeren satırın tamamı
        yazılmaz. Yazdığınız metnin o kullanıcıda nasıl göründüğünü kaydetmeden önce
        “Önizle” ile görebilirsiniz.
      </div>

      <div className="liste">
        {konular.map((topic) => {
          const satirlar = (veri?.templates ?? []).filter((satir) => satir.topic === topic);

          return satirlar.map((satir) => {
            const bu = anahtar(satir);
            const acikMi = acikSatir === bu;

            return (
              <div className="liste-satir" key={bu} style={{ display: 'block' }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: 12,
                  }}
                >
                  <div>
                    <p className="urun-ad">
                      {satir.topicLabel} · {satir.channelLabel}
                    </p>
                    <p className="urun-alt">
                      {satir.subjectTemplate ?? satir.defaultSubject}
                    </p>
                    <p className="urun-alt" style={{ opacity: 0.75 }}>
                      {satir.customized
                        ? `Özelleştirilmiş${
                            satir.updatedByName ? ` · ${satir.updatedByName}` : ''
                          }${
                            satir.updatedAt
                              ? ` · ${new Date(satir.updatedAt).toLocaleString('tr-TR')}`
                              : ''
                          }`
                        : 'Varsayılan metin yürürlükte'}
                    </p>
                  </div>

                  <div className="satir-eylem" style={{ gap: 8 }}>
                    {satir.customized && (
                      <button
                        type="button"
                        className="dugme dugme-ikincil dugme-kucuk"
                        disabled={islemde}
                        onClick={() => void varsayilanaDon(satir.topic, satir.channel)}
                      >
                        Varsayılana dön
                      </button>
                    )}
                    <button
                      type="button"
                      className="dugme dugme-kucuk"
                      onClick={() => (acikMi ? kapat() : ac(satir))}
                    >
                      {acikMi ? 'Kapat' : 'Düzenle'}
                    </button>
                  </div>
                </div>

                {acikMi && acik && (
                  <div style={{ marginTop: 16 }}>
                    <div className="alan">
                      <label className="alan-etiket" htmlFor="sablon-konu">
                        Konu satırı
                      </label>
                      <input
                        id="sablon-konu"
                        className="alan-girdi"
                        value={konu}
                        maxLength={200}
                        onChange={(olay) => setKonu(olay.target.value)}
                      />
                    </div>

                    <div className="alan">
                      <label className="alan-etiket" htmlFor="sablon-govde">
                        Gövde
                      </label>
                      <textarea
                        id="sablon-govde"
                        className="alan-girdi"
                        rows={12}
                        value={govde}
                        maxLength={4000}
                        style={{ fontFamily: 'ui-monospace, monospace', lineHeight: 1.6 }}
                        onChange={(olay) => setGovde(olay.target.value)}
                      />
                    </div>

                    <p className="urun-alt" style={{ marginBottom: 6 }}>
                      Kullanılabilir değişkenler — tıklayınca gövdenin sonuna eklenir:
                    </p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
                      {acik.variables.map((degisken) => (
                        <button
                          key={degisken.key}
                          type="button"
                          className="dugme dugme-ikincil dugme-kucuk"
                          title={`${degisken.label} · örnek: ${degisken.example}`}
                          onClick={() => degiskenEkle(degisken.key)}
                        >
                          {`{{${degisken.key}}}`}
                          {degisken.financial && ' ₺'}
                        </button>
                      ))}
                    </div>

                    {bilinmeyen.length > 0 && (
                      <div className="uyari-kutu hata">
                        Tanınmayan değişken: {bilinmeyen.map((ad) => `{{${ad}}}`).join(', ')} —
                        bu satırlar hiçbir alıcıya gönderilmez.
                      </div>
                    )}

                    <div className="satir-eylem" style={{ gap: 8, marginBottom: 14 }}>
                      <button
                        type="button"
                        className="dugme dugme-ikincil"
                        disabled={islemde}
                        onClick={() => void onizle()}
                      >
                        Önizle
                      </button>
                      <button
                        type="button"
                        className="dugme"
                        disabled={islemde || bilinmeyen.length > 0}
                        onClick={() => void kaydet()}
                      >
                        Kaydet
                      </button>
                    </div>

                    {onizleme && (
                      <div className="olcum-izgara">
                        <article className="olcum">
                          <p className="olcum-etiket">Fiyat gören alıcı</p>
                          <p style={{ fontWeight: 600, fontSize: 14, margin: '6px 0' }}>
                            {onizleme.standard.subject}
                          </p>
                          <pre
                            style={{
                              whiteSpace: 'pre-wrap',
                              fontSize: 13,
                              lineHeight: 1.6,
                              margin: 0,
                            }}
                          >
                            {onizleme.standard.body}
                          </pre>
                        </article>

                        <article className="olcum">
                          <p className="olcum-etiket">Kör Sipariş Modundaki alıcı</p>
                          <p style={{ fontWeight: 600, fontSize: 14, margin: '6px 0' }}>
                            {onizleme.blind.subject}
                          </p>
                          <pre
                            style={{
                              whiteSpace: 'pre-wrap',
                              fontSize: 13,
                              lineHeight: 1.6,
                              margin: 0,
                            }}
                          >
                            {onizleme.blind.body}
                          </pre>
                          <p className="olcum-alt">
                            {onizleme.droppedLineCount > 0
                              ? `${onizleme.droppedLineCount} satır düşürüldü — parasal değer taşıdığı için.`
                              : 'Bu metin parasal değer taşımıyor; iki sürüm aynı.'}
                          </p>
                        </article>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          });
        })}
      </div>
    </div>
  );
}
