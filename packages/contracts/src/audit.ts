import { z } from 'zod';

/**
 * ToptanPortal - Yasal Delil Loglama Sozlugu
 *
 * 5651 sayili Kanun (trafik/islem kaydi) ve 5070 sayili Elektronik Imza Kanunu
 * cercevesinde ticari ispat yukumlulugu geregi; her finansal ve ticari aksiyon
 * degistirilemez (immutable) sekilde kayit altina alinir.
 *
 * Kayitlar hash zinciri ile birbirine baglanir:
 *   hash(n) = SHA256( hash(n-1) || canonicalJson(kayit(n)) )
 * Zincirin herhangi bir halkasi silinir veya degistirilirse sonraki tum
 * hash'ler tutmaz; mudahale matematiksel olarak ispatlanabilir hale gelir.
 */

export const AuditAction = {
  // --- Kimlik / oturum ---
  AUTH_LOGIN_SUCCESS: 'auth.login.success',
  AUTH_LOGIN_FAILED: 'auth.login.failed',
  AUTH_LOGIN_BLOCKED: 'auth.login.blocked',
  AUTH_MFA_CHALLENGED: 'auth.mfa.challenged',
  AUTH_MFA_SUCCESS: 'auth.mfa.success',
  AUTH_MFA_FAILED: 'auth.mfa.failed',
  AUTH_MFA_ENROLLED: 'auth.mfa.enrolled',
  AUTH_MFA_RESET: 'auth.mfa.reset',
  AUTH_RECOVERY_CODE_USED: 'auth.recovery-code.used',
  AUTH_TOKEN_REFRESHED: 'auth.token.refreshed',
  AUTH_TOKEN_REUSE_DETECTED: 'auth.token.reuse-detected',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_SESSION_REVOKED: 'auth.session.revoked',
  AUTH_PASSWORD_CHANGED: 'auth.password.changed',
  AUTH_ACCOUNT_LOCKED: 'auth.account.locked',
  AUTH_IP_REJECTED: 'auth.ip.rejected',
  AUTH_PERMISSION_DENIED: 'auth.permission.denied',

  // --- Masquerading (plasiyerin bayi yerine gecmesi) ---
  MASQUERADE_STARTED: 'masquerade.started',
  MASQUERADE_ENDED: 'masquerade.ended',

  // --- Finansal gorunurluk (ispat icin kritik) ---
  PRICE_VIEWED: 'finance.price.viewed',
  BALANCE_VIEWED: 'finance.balance.viewed',
  STATEMENT_VIEWED: 'finance.statement.viewed',
  INVOICE_DOWNLOADED: 'finance.invoice.downloaded',
  RECONCILIATION_DOWNLOADED: 'finance.reconciliation.downloaded',
  BLIND_ORDER_APPLIED: 'finance.blind-order.applied',

  // --- Siparis ---
  ORDER_DRAFT_CREATED: 'order.draft.created',
  ORDER_SUBMITTED_FOR_APPROVAL: 'order.submitted-for-approval',
  ORDER_APPROVED: 'order.approved',
  ORDER_REJECTED: 'order.rejected',
  ORDER_PLACED: 'order.placed',
  ORDER_CANCELLED: 'order.cancelled',
  ORDER_RISK_BLOCKED: 'order.risk.blocked',
  STOCK_RESERVED: 'stock.reserved',
  STOCK_RESERVATION_RELEASED: 'stock.reservation.released',

  // --- Odeme ---
  PAYMENT_INITIATED: 'payment.initiated',
  PAYMENT_SUCCEEDED: 'payment.succeeded',
  PAYMENT_FAILED: 'payment.failed',

  // --- Kullanici / yetki yonetimi ---
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_ROLE_CHANGED: 'user.role.changed',
  USER_SUSPENDED: 'user.suspended',
  USER_REACTIVATED: 'user.reactivated',
  USER_LIMIT_CHANGED: 'user.limit.changed',
  IP_WHITELIST_CHANGED: 'admin.ip-whitelist.changed',

  // --- Mevzuat ---
  CONSENT_GRANTED: 'consent.granted',
  CONSENT_REVOKED: 'consent.revoked',
  IYS_SYNC_SUCCEEDED: 'consent.iys.sync.succeeded',
  IYS_SYNC_FAILED: 'consent.iys.sync.failed',

  // --- e-Belge ---
  /**
   * Belge KESILDI. Geri alinamayan bir islemdir: numara tuketilmis, belge
   * hukuken dogmustur ve duzeltmesi ancak iade faturasiyla yapilir. Kimin
   * hangi siparisten hangi numarayi urettigi, defterin kendisi kadar onemlidir.
   */
  EDOCUMENT_ISSUED: 'e-document.issued',
  EDOCUMENT_SENT: 'e-document.sent',
  EDOCUMENT_STATUS_CHANGED: 'e-document.status.changed',

  // --- Bildirim ---
  /**
   * Bildirim metni degistirildi.
   *
   * Sablon, bundan sonra gidecek HER iletiyi degistirir; "portal bize boyle
   * yazmisti" tartismasinda metnin ne zaman ve kimin tarafindan
   * degistirildigi, gonderilmis iletinin kendisi kadar onemlidir.
   */
  NOTIFICATION_TEMPLATE_CHANGED: 'notification.template.changed',
  NOTIFICATION_TEMPLATE_RESET: 'notification.template.reset',

  // --- Entegrasyon ---
  LOGO_SYNC_STARTED: 'integration.logo.sync.started',
  LOGO_SYNC_COMPLETED: 'integration.logo.sync.completed',
  LOGO_SYNC_FAILED: 'integration.logo.sync.failed',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

/**
 * Aksiyon kodunu okunabilir etiketle eslestirir.
 *
 * Etiket BULUNAMAZSA kodun kendisi gosterilir - yeni bir aksiyon eklendiginde
 * denetim ekrani bos hucre gostermez, ham kodu gosterir. Delil sunumunda
 * "bilinmeyen" yazan bir satir, hic olmayan bir satirdan daha kotudur.
 */
export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  'auth.login.success': 'Giriş yapıldı',
  'auth.login.failed': 'Giriş başarısız',
  'auth.login.blocked': 'Giriş engellendi',
  'auth.mfa.challenged': '2FA istendi',
  'auth.mfa.success': '2FA doğrulandı',
  'auth.mfa.failed': '2FA başarısız',
  'auth.mfa.enrolled': '2FA kaydı yapıldı',
  'auth.mfa.reset': '2FA sıfırlandı',
  'auth.recovery-code.used': 'Kurtarma kodu kullanıldı',
  'auth.token.refreshed': 'Oturum yenilendi',
  'auth.token.reuse-detected': 'Jeton yeniden kullanımı tespit edildi',
  'auth.logout': 'Çıkış yapıldı',
  'auth.session.revoked': 'Oturum sonlandırıldı',
  'finance.blind-order.applied': 'Kör Sipariş süzgeci uygulandı',
  'order.draft.created': 'Sepet oluşturuldu',
  'order.submitted-for-approval': 'Sipariş onaya gönderildi',
  'order.approved': 'Sipariş onaylandı',
  'order.rejected': 'Sipariş reddedildi',
  'order.placed': 'Sipariş oluşturuldu',
  'order.cancelled': 'Sipariş iptal edildi',
  'order.risk.blocked': 'Sipariş risk nedeniyle durduruldu',
  'payment.initiated': 'Tahsilat başlatıldı',
  'payment.succeeded': 'Tahsilat tamamlandı',
  'payment.failed': 'Tahsilat başarısız',
  'e-document.issued': 'e-Belge kesildi',
  'e-document.sent': 'e-Belge entegratöre iletildi',
  'e-document.status.changed': 'e-Belge durumu değişti',
  'notification.template.changed': 'Bildirim metni değiştirildi',
  'notification.template.reset': 'Bildirim metni varsayılana döndürüldü',
  'integration.logo.sync.started': 'Logo senkronu başladı',
  'integration.logo.sync.completed': 'Logo senkronu tamamlandı',
  'integration.logo.sync.failed': 'Logo senkronu başarısız',
};

export const AuditActorType = {
  USER: 'USER',
  SYSTEM: 'SYSTEM',
  INTEGRATION: 'INTEGRATION',
} as const;

export type AuditActorType = (typeof AuditActorType)[keyof typeof AuditActorType];

/**
 * Kanonik JSON serilestirme.
 * Hash zincirinin dogrulanabilir olmasi icin ayni veri her zaman ayni byte
 * dizisini uretmelidir. JSON.stringify anahtar sirasini nesne olusturma
 * sirasina gore verir - bu yeterli degildir; anahtarlar leksikografik olarak
 * siralanir, undefined degerler atilir, Date ISO-8601'e cevrilir.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeForCanonical(value));
}

function normalizeForCanonical(value: unknown): unknown {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'bigint') return value.toString();

  if (Array.isArray(value)) return value.map((item) => normalizeForCanonical(item));

  if (typeof value === 'object') {
    // Prisma.Decimal ve benzeri toJSON/toString sunan tipler
    const maybe = value as { toJSON?: () => unknown };
    if (typeof maybe.toJSON === 'function') {
      return normalizeForCanonical(maybe.toJSON());
    }

    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      result[key] = normalizeForCanonical(source[key]);
    }
    return result;
  }

  if (typeof value === 'number' && !Number.isFinite(value)) return null;

  return value;
}

/** Zincirin ilk halkasinin onceki hash degeri (64 karakter sifir). */
export const AUDIT_GENESIS_HASH = '0'.repeat(64);

// ---------------------------------------------------------------------------
// Denetim kaydi sorgulama
// ---------------------------------------------------------------------------

export const auditQuerySchema = z.object({
  action: z.string().trim().max(80).optional(),
  actorEmail: z.string().trim().max(254).optional(),
  resourceType: z.string().trim().max(60).optional(),
  resourceId: z.string().trim().max(64).optional(),
  companyId: z.string().uuid().optional(),
  outcome: z.enum(['SUCCESS', 'FAILURE', 'DENIED']).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type AuditQuery = z.infer<typeof auditQuerySchema>;

export const auditEntrySchema = z.object({
  id: z.string(),
  /** Kiraci icindeki bosluksuz sira numarasi. Bosluk = silinmis kayit. */
  seq: z.string(),
  occurredAt: z.string(),
  actorType: z.string(),
  actorEmail: z.string().nullable(),
  actorRole: z.string().nullable(),
  action: z.string(),
  actionLabel: z.string(),
  outcome: z.string(),
  resourceType: z.string().nullable(),
  resourceId: z.string().nullable(),
  companyId: z.string().nullable(),
  ip: z.string().nullable(),
  requestId: z.string().nullable(),
  payload: z.record(z.unknown()),
  /** Zincir ozeti - delil sunumunda bu deger karsilastirilir. */
  hash: z.string(),
});

export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditPageSchema = z.object({
  entries: z.array(auditEntrySchema),
  totalCount: z.number().int(),
  hasMore: z.boolean(),
  /**
   * Zincirin son halkasi. Arayuz bunu gosterir ki delil sunumu yapan kisi,
   * ekrandaki kayitlarin hangi zincir noktasina kadar dogrulandigini bilsin.
   */
  chainHead: z.object({ lastSeq: z.string(), lastHash: z.string() }).nullable(),
});

export type AuditPage = z.infer<typeof auditPageSchema>;

/**
 * Zincir dogrulama sonucu.
 *
 * `verifiedCount` ile `totalCount` FARKLI olabilir: dogrulama pahalidir ve
 * ekrandan tetiklenen kontrol son N kaydi tarar. Tam tarama komut satirindan
 * yapilir (`pnpm --filter @toptanportal/db verify-audit`).
 */
export const auditVerifyResultSchema = z.object({
  valid: z.boolean(),
  verifiedCount: z.number().int(),
  /** Zincirin ilk kirildigi sira numarasi. */
  brokenAtSeq: z.string().nullable(),
  message: z.string(),
});

export type AuditVerifyResult = z.infer<typeof auditVerifyResultSchema>;
