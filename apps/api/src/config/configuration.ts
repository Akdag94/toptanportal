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

    /**
     * Sanal POS. Hicbiri tanimli degilse kart ile odeme KAPALIDIR ve arayuz
     * dugmeyi hic gostermez - yarim yapilandirilmis bir POS, kullaniciyi
     * bankaya gonderip hata sayfasinda birakir.
     */
    POS_PROVIDER: z.enum(['nestpay']).optional(),
    POS_MERCHANT_ID: z.string().optional(),
    POS_TERMINAL_ID: z.string().optional(),
    /** Magaza anahtari. Ozet hesabinda kullanilir, hicbir yanitta gonderilmez. */
    POS_STORE_KEY: z.string().optional(),
    POS_GATEWAY_URL: z.string().url().optional(),
    /** Bankanin geri donecegi adres. API'nin DIS adresi olmalidir. */
    POS_CALLBACK_URL: z.string().url().optional(),
    POS_MAX_INSTALLMENT: z.coerce.number().int().min(1).max(12).default(6),

    /**
     * e-Belge arsivinin kok dizini. XML ve PDF dosyalari buraya yazilir;
     * veritabani yalnizca goreli yolu tutar.
     *
     * Uretimde bu dizin AG DEPOSU veya nesne deposu baglamasi olmalidir:
     * uygulama sunucusunun yerel diski, 10 yillik saklama yukumlulugunu
     * tasiyacak dayaniklilikta degildir.
     */
    EDOCUMENT_STORAGE_PATH: z.string().min(1).default('./storage/e-documents'),
    /** Imzali indirme baglantisinin omru. Kisa tutulur: baglanti paylasilabilir. */
    EDOCUMENT_LINK_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),

    /**
     * e-Belge uretim hatti (entegrator baglantisi).
     *
     * Hicbiri tanimli degilse belge URETIMI kapalidir; arsiv ve sunum tarafi
     * calismaya devam eder. Yarim yapilandirma kabul edilmez: adresi olup
     * anahtari olmayan bir kurulum, faturayi uretip gonderemez ve belge
     * numarasini tuketmis olur.
     *
     * MALI MUHUR portalde DEGILDIR. Imzalama entegratorde yapilir; muhurun
     * ozel anahtarini bir web uygulamasinin surecine koymak, o surecin her
     * acigini imza yetkisine cevirir.
     */
    EINVOICE_PROVIDER_URL: z.string().url().optional(),
    EINVOICE_API_KEY: z.string().optional(),
    /** Belgeyi kesen firmanin VKN'si. Belgedeki satici tarafinin kimligidir. */
    EINVOICE_SENDER_TAX_NUMBER: z.string().regex(/^\d{10}$/).optional(),
    EINVOICE_SENDER_TITLE: z.string().optional(),
    EINVOICE_SENDER_TAX_OFFICE: z.string().optional(),
    EINVOICE_SENDER_ADDRESS: z.string().optional(),
    EINVOICE_SENDER_CITY: z.string().optional(),
    EINVOICE_SENDER_DISTRICT: z.string().optional(),
    /** Belge numarasinin 3 harfli seri onu (ornek: MRM2026000000431). */
    EINVOICE_SERIES_PREFIX: z
      .string()
      .regex(/^[A-ZÇĞİÖŞÜ]{3}$/, 'Seri önü tam üç büyük harf olmalıdır.')
      .default('TPL'),
    EINVOICE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
    /** Belgeyi entegratore gonderme turu. */
    JOB_EDOCUMENT_DISPATCH_SECONDS: z.coerce.number().int().min(15).max(3600).default(60),
    /**
     * GIB durum takibi turu.
     *
     * Gonderilmis bir belgenin akibetini SORMAK zorundayiz: entegrator geri
     * bildirim yapsa bile o bildirim kaybolabilir ve "fatura ulasti mi"
     * sorusunun cevabini portalin kendi kaydindan verebilmesi gerekir.
     */
    JOB_EDOCUMENT_STATUS_SECONDS: z.coerce.number().int().min(60).max(86400).default(900),

    /**
     * Bildirim gonderimi.
     *
     * Saglayici HTTP ucu uzerinden konusulur; SMTP kutuphanesi yerine tek bir
     * `NotificationTransport` arayuzu vardir ve SMTP isteyen kurulum yalnizca
     * o arayuzu uygular. Boylece kimlik bilgisi, zaman asimi ve hata
     * siniflandirmasi tek yerde kalir.
     *
     * Yapilandirma EKSIKSE gonderim yapilmaz; mesajlar "gonderilmedi" olarak
     * kaydedilir ve ekranda gorunur. Sessizce basarili saymak, portalin
     * bildirdigi ama kimsenin almadigi bir dunyayi uretir.
     */
    MAIL_API_URL: z.string().url().optional(),
    MAIL_API_KEY: z.string().optional(),
    MAIL_FROM: z.string().email().optional(),
    MAIL_FROM_NAME: z.string().default('ToptanPortal'),
    MAIL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(8000),

    /** Mobil bildirim rolesi. Tanimsizsa PUSH kanali kapali kabul edilir. */
    PUSH_API_URL: z.string().url().optional(),
    PUSH_API_KEY: z.string().optional(),

    JOB_NOTIFICATION_DISPATCH_SECONDS: z.coerce.number().int().min(10).max(600).default(30),
    JOB_DUE_REMINDER_SECONDS: z.coerce.number().int().min(300).max(86400).default(3600),
    /** Vadesine bu kadar gun kalan belge icin hatirlatma uretilir. */
    DUE_REMINDER_LEAD_DAYS: z.coerce.number().int().min(0).max(30).default(3),
    /**
     * Bildirim kaydinin saklama suresi. KVKK gereginden uzun saklamayi
     * yasaklar: bu tablo alici adreslerini ve ticari iliskinin ayrintisini
     * tasir, sinirsiz buyumesi icin bir sebep yoktur.
     */
    NOTIFICATION_RETENTION_DAYS: z.coerce.number().int().min(30).max(3650).default(180),

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

    /* Posta yapilandirmasi ya tamamdir ya da yoktur. Yarim yapilandirma
       (adres var, anahtar yok) uretimde en kotu haldir: uygulama acilir,
       kullanici sifre sifirlama bekler ve hicbir sey gelmez. */
    const mailFields = [
      ['MAIL_API_URL', env.MAIL_API_URL],
      ['MAIL_API_KEY', env.MAIL_API_KEY],
      ['MAIL_FROM', env.MAIL_FROM],
    ] as const;

    const eksikMail = mailFields.filter(([, value]) => !value).map(([key]) => key);

    if (eksikMail.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [eksikMail[0] as string],
        message:
          `Üretim ortamında e-posta gönderimi zorunludur; eksik alanlar: ${eksikMail.join(', ')}. ` +
          'Bildirim gönderemeyen bir portal, güvenlik uyarısını da gönderemez.',
      });
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

  /* POS ya TAMAMEN yapilandirilir ya da hic yapilandirilmaz. Yarim
     yapilandirma, calisiyor sanilan ama her odemede basarisiz olan bir akis
     uretir ve bunu ilk fark eden musteri olur. */
  const posFields = [
    env.POS_PROVIDER,
    env.POS_MERCHANT_ID,
    env.POS_STORE_KEY,
    env.POS_GATEWAY_URL,
    env.POS_CALLBACK_URL,
  ];

  if (posFields.some((value) => value !== undefined) && posFields.some((value) => value === undefined)) {
    throw new Error(
      'Sanal POS yapılandırması eksik. POS_PROVIDER, POS_MERCHANT_ID, POS_STORE_KEY, ' +
        'POS_GATEWAY_URL ve POS_CALLBACK_URL ya birlikte tanımlanmalı ya da hiçbiri tanımlanmamalıdır.',
    );
  }

  if (isProduction && env.POS_CALLBACK_URL?.startsWith('http://')) {
    throw new Error('POS_CALLBACK_URL üretim ortamında HTTPS olmalıdır.');
  }

  if (isProduction && env.LOGO_BRIDGE_BASE_URL === undefined) {
    throw new Error('Üretim ortamında LOGO_BRIDGE_BASE_URL tanımlı olmalıdır.');
  }

  /* e-Belge uretimi ya tamamdir ya da yoktur. Yarim yapilandirmayla uretilen
     bir fatura, belge numarasini TUKETIR ve gonderilemez; tuketilmis numara
     defterde iptal edilmis bir belge olarak durur ve aciklanmasi gerekir. */
  const eInvoiceFields = [
    env.EINVOICE_PROVIDER_URL,
    env.EINVOICE_API_KEY,
    env.EINVOICE_SENDER_TAX_NUMBER,
    env.EINVOICE_SENDER_TITLE,
  ];

  if (
    eInvoiceFields.some((value) => value !== undefined) &&
    eInvoiceFields.some((value) => value === undefined)
  ) {
    throw new Error(
      'e-Belge yapılandırması eksik. EINVOICE_PROVIDER_URL, EINVOICE_API_KEY, ' +
        'EINVOICE_SENDER_TAX_NUMBER ve EINVOICE_SENDER_TITLE ya birlikte tanımlanmalı ' +
        'ya da hiçbiri tanımlanmamalıdır.',
    );
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
