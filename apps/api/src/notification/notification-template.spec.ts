/**
 * Bildirim metni testleri.
 *
 * Bu dosyanin asil isi bir GUVENLIK sozlesmesini kilitlemektir: Kor Siparis
 * Modundaki kullaniciya giden hicbir bildirim parasal deger tasimamalidir.
 * Arayuzde ozenle gizlenen tutarin posta kutusuna dusmesi, gizlemenin
 * tamamini bosa cikarir - ve bu sizinti sessizdir, kimse fark etmez.
 */

import { NotificationChannel, NotificationTopic } from '@toptanportal/contracts';

import { renderNotification, type NotificationPayload, type RenderInput } from './notification-template';

const TEMEL: Omit<RenderInput, 'payload'> = {
  channel: NotificationChannel.EMAIL,
  recipientName: 'Ayşe Yılmaz',
  canSeeFinancials: true,
  webBaseUrl: 'https://portal.example.com',
};

function uret(payload: NotificationPayload, ekler: Partial<RenderInput> = {}) {
  return renderNotification({ ...TEMEL, payload, ...ekler });
}

const SIPARIS_DURUMU: NotificationPayload = {
  topic: NotificationTopic.ORDER_STATUS,
  orderNumber: 'SP-2026-000418',
  statusLabel: 'Onaylandı',
  companyTitle: 'Marmara Otelcilik A.Ş.',
  grandTotal: 12480,
  currency: 'TRY',
};

const ONAY_BEKLIYOR: NotificationPayload = {
  topic: NotificationTopic.ORDER_APPROVAL_PENDING,
  orderNumber: 'SP-2026-000419',
  requestedByName: 'Mehmet Barista',
  grandTotal: 3240.5,
  currency: 'TRY',
  lineCount: 7,
};

describe('Kör Sipariş Modu — metinde tutar bulunmaz', () => {
  it('sipariş durumu bildiriminde tutar satırı hiç yazılmaz', () => {
    const { subject, body } = uret(SIPARIS_DURUMU, { canSeeFinancials: false });

    expect(body).not.toContain('12.480');
    expect(body).not.toContain('TL');
    expect(body).not.toMatch(/tutar/i);
    // Siparisin durumu ise GIZLENMEZ: fiyati gormemek, siparisinin
    // onaylandigini bilmemek anlamina gelmez.
    expect(subject).toContain('Onaylandı');
    expect(body).toContain('SP-2026-000418');
  });

  it('onay bekleyen sipariş bildiriminde tutar satırı hiç yazılmaz', () => {
    const { body } = uret(ONAY_BEKLIYOR, { canSeeFinancials: false });

    expect(body).not.toContain('3.240');
    expect(body).toContain('7 kalem');
  });

  it('yetki varsa tutar Türkçe biçimde yazılır', () => {
    const { body } = uret(SIPARIS_DURUMU);
    expect(body).toContain('12.480,00 TL');
  });

  it('tutar bilinmiyorsa satır üretilmez — "null TL" yazmaktansa hiç yazma', () => {
    const { body } = uret({ ...SIPARIS_DURUMU, grandTotal: null });
    expect(body).not.toMatch(/tutar/i);
  });
});

describe('konu satırı', () => {
  it('sipariş tutarını taşımaz — konu satırı kilit ekranında görünür', () => {
    const { subject } = uret(SIPARIS_DURUMU);
    expect(subject).not.toContain('12.480');
  });

  it('tek başına bilgi taşır: gövde açılmadan ne olduğu anlaşılır', () => {
    expect(uret(SIPARIS_DURUMU).subject).toContain('SP-2026-000418');
    expect(uret(ONAY_BEKLIYOR).subject).toContain('SP-2026-000419');
  });
});

describe('vade hatırlatması', () => {
  const temel = {
    topic: NotificationTopic.DUE_DATE_REMINDER,
    documentNumber: 'FT-2026-004120',
    dueDate: '2026-07-20T00:00:00.000Z',
    amount: 8750.25,
    currency: 'TRY',
  } as const;

  it('vadesi gelmemiş belge için "geçti" demez', () => {
    const { subject, body } = uret({ ...temel, daysOverdue: -3 });

    expect(subject).toContain('yaklaşan');
    expect(body).not.toMatch(/doldu/);
  });

  it('vadesi geçen belgede gün sayısını yazar', () => {
    const { subject, body } = uret({ ...temel, daysOverdue: 12 });

    expect(subject).toContain('geçen');
    expect(body).toContain('12 gün');
  });

  it('ödeme ile çakışma ihtimalini kabul eder', () => {
    const { body } = uret({ ...temel, daysOverdue: 5 });
    expect(body).toContain('dikkate almayınız');
  });
});

describe('güvenlik bildirimi', () => {
  const payload: NotificationPayload = {
    topic: NotificationTopic.SECURITY,
    eventLabel: 'Yeni cihazdan giriş',
    city: 'İstanbul',
    ip: '203.0.113.10',
    occurredAt: '2026-07-28T09:15:00.000Z',
  };

  it('kullanıcıyı harekete geçirecek adımı içerir', () => {
    const { body } = uret(payload);

    expect(body).toContain('şifrenizi hemen değiştirin');
    expect(body).toContain('/panel/guvenlik');
  });

  it('konum bilgisi yoksa boş satır bırakmaz', () => {
    const { body } = uret({ ...payload, city: null, ip: null });
    expect(body).not.toContain('Konum:');
  });
});

describe('mobil bildirim', () => {
  it('gövdeyi tek satıra indirir ve kısaltır', () => {
    const { body } = uret(SIPARIS_DURUMU, { channel: NotificationChannel.PUSH });

    expect(body).not.toContain('\n');
    expect(body.length).toBeLessThanOrEqual(160);
  });

  it('kısaltırken de kör mod kuralını bozmaz', () => {
    const { body } = uret(SIPARIS_DURUMU, {
      channel: NotificationChannel.PUSH,
      canSeeFinancials: false,
    });

    expect(body).not.toContain('12.480');
  });
});
