/**
 * ToptanPortal API - Ortam Yapilandirmasi
 *
 * Uygulama ACILIRKEN dogrulanir. Eksik veya zayif bir anahtar varsa surec
 * hicbir istek almadan durur - yanlis yapilandirmayla uretime cikmak,
 * calismamaktan daha tehlikelidir.
 */

import { z } from 'zod';

const booleanFromEnv = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    API_BASE_URL: z.string().url(),
    WEB_BASE_URL: z.string().url(),

    DATABASE_URL: z.string().min(1),

    REDIS_HOST: z.string().min(1).default('localhost'),
    REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),
    REDIS_PASSWORD: z.string().optional(),
    REDIS_DB: z.coerce.number().int().min(0).max(15).default(0),
    REDIS_TLS: booleanFromEnv.default(false),

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET en az 32 karakter olmalıdır.'),
    JWT_ACCESS_TTL: z.coerce.number().int().min(60).max(3600).default(900),
    JWT_REFRESH_TTL: z.coerce.number().int().min(3600).default(2592000),
    JWT_MFA_CHALLENGE_TTL: z.coerce.number().int().min(60).max(900).default(300),
    JWT_ISSUER: z.string().min(1).default('toptanportal'),
    JWT_AUDIENCE: z.string().min(1).default('toptanportal-clients'),

    FIELD_ENCRYPTION_ACTIVE_KEY_ID: z.string().min(1),
    /** Bicim: "k1:base64key,k2:base64key" - rotasyon icin coklu anahtar. */
    FIELD_ENCRYPTION_KEYS: z.string().min(1),
    BLIND_INDEX_KEY: z.string().min(1),

    TRUST_CLOUDFLARE_HEADERS: booleanFromEnv.default(true),
    LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),
    LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
    LOGIN_ATTEMPT_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
    PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).max(64).default(10),
    TOTP_ISSUER: z.string().min(1).default('ToptanPortal'),
    SUPER_ADMIN_IP_WHITELIST_ENFORCED: booleanFromEnv.default(true),

    /**
     * Bakim gorevleri. Yalnizca gorevleri ayri bir surecte calistiran
     * kurulumlarda kapatilir; tek surecli kurulumda kapatmak, suresi dolan
     * stok rezervasyonlarinin hic serbest birakilmamasi demektir.
     */
    MAINTENANCE_JOBS_ENABLED: booleanFromEnv.default(true),
    JOB_RESERVATION_RELEASE_SECONDS: z.coerce.number().int().min(30).max(3600).default(120),
    JOB_IDEMPOTENCY_PURGE_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
    JOB_OUTBOX_WATCH_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    /** Bu sureden uzun bekleyen outbox olayi uyari uretir. */
    OUTBOX_STALE_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),

    /**
     * Senkron turlerinin sikligi. Stok en sik, fiyat en seyrek calisir:
     * stok dakikalar icinde eskiyip yok-satmaya yol acar, fiyat listesi ise
     * gunde birkac kez degisir ve her turda tum kartlari tarar.
     */
    JOB_STOCK_SYNC_SECONDS: z.coerce.number().int().min(30).max(3600).default(120),
    JOB_PRICE_SYNC_SECONDS: z.coerce.number().int().min(60).max(86400).default(1800),
    JOB_ACCOUNT_SYNC_SECONDS: z.coerce.number().int().min(60).max(86400).default(900),
    JOB_ORDER_DISPATCH_SECONDS: z.coerce.number().int().min(10).max(600).default(30),
    JOB_BRIDGE_PROBE_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),

    LOGO_BRIDGE_BASE_URL: z.string().url().optional(),
    LOGO_BRIDGE_CLIENT_CERT_PATH: z.string().optional(),
    LOGO_BRIDGE_CLIENT_KEY_PATH: z.string().optional(),
    LOGO_BRIDGE_CA_PATH: z.string().optional(),
    LOGO_BRIDGE_TIMEOUT_MS: z.coerce.number().int().min(500).max(30000).default(4000),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;

    // Uretimde varsayilan/sablon degerlerle acilmayi kesinlikle engelle.
    const placeholders = [
      ['JWT_ACCESS_SECRET', env.JWT_ACCESS_SECRET],
      ['FIELD_ENCRYPTION_KEYS', env.FIELD_ENCRYPTION_KEYS],
      ['BLIND_INDEX_KEY', env.BLIND_INDEX_KEY],
    ] as const;

    for (const [key, value] of placeholders) {
      if (value.includes('CHANGE_ME')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} üretim ortamında şablon değeriyle bırakılamaz.`,
        });
      }
    }

    if (!env.SUPER_ADMIN_IP_WHITELIST_ENFORCED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SUPER_ADMIN_IP_WHITELIST_ENFORCED'],
        message: 'Üretim ortamında Süper Admin IP beyaz listesi devre dışı bırakılamaz.',
      });
    }
  });

export type EnvConfig = z.infer<typeof envSchema>;

export interface EncryptionKeyRing {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
  blindIndexKey: Buffer;
}

export interface AppConfig extends EnvConfig {
  encryption: EncryptionKeyRing;
}

function parseKeyRing(raw: string, activeKeyId: string): EncryptionKeyRing['keys'] {
  const keys = new Map<string, Buffer>();

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;

    const separatorIndex = trimmed.indexOf(':');
    if (separatorIndex <= 0) {
      throw new Error(
        `FIELD_ENCRYPTION_KEYS biçimi hatalı. Beklenen biçim: "anahtarId:base64Anahtar".`,
      );
    }

    const keyId = trimmed.slice(0, separatorIndex).trim();
    const material = Buffer.from(trimmed.slice(separatorIndex + 1).trim(), 'base64');

    if (material.length !== 32) {
      throw new Error(
        `"${keyId}" şifreleme anahtarı 32 bayt olmalıdır (AES-256). Bulunan: ${material.length} bayt.`,
      );
    }

    keys.set(keyId, material);
  }

  if (!keys.has(activeKeyId)) {
    throw new Error(
      `FIELD_ENCRYPTION_ACTIVE_KEY_ID ("${activeKeyId}") anahtar zincirinde bulunamadı.`,
    );
  }

  return keys;
}

/**
 * Ortam degiskenlerini dogrular ve tip guvenli yapilandirmayi uretir.
 * Hata durumunda anlasilir bir mesajla surec sonlandirilir.
 */
export function loadConfiguration(): AppConfig {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(kök)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Ortam yapılandırması geçersiz:\n${details}`);
  }

  const env = parsed.data;

  const isProduction = env.NODE_ENV === 'production';
  const keys = parseKeyRing(env.FIELD_ENCRYPTION_KEYS, env.FIELD_ENCRYPTION_ACTIVE_KEY_ID);
  const blindIndexKey = Buffer.from(env.BLIND_INDEX_KEY, 'base64');

  if (blindIndexKey.length < 32) {
    throw new Error('BLIND_INDEX_KEY en az 32 bayt (base64) olmalıdır.');
  }

  if (isProduction && env.LOGO_BRIDGE_BASE_URL === undefined) {
    throw new Error('Üretim ortamında LOGO_BRIDGE_BASE_URL tanımlı olmalıdır.');
  }

  return {
    ...env,
    encryption: {
      activeKeyId: env.FIELD_ENCRYPTION_ACTIVE_KEY_ID,
      keys,
      blindIndexKey,
    },
  };
}

/** Nest ConfigModule icin fabrika. */
export const configurationFactory = (): { app: AppConfig } => ({
  app: loadConfiguration(),
});

export const CONFIG_NAMESPACE = 'app';
