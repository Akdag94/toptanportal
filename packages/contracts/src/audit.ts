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

  // --- Entegrasyon ---
  LOGO_SYNC_STARTED: 'integration.logo.sync.started',
  LOGO_SYNC_COMPLETED: 'integration.logo.sync.completed',
  LOGO_SYNC_FAILED: 'integration.logo.sync.failed',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

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
