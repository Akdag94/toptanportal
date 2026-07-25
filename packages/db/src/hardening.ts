/**
 * ToptanPortal - Veritabani Sertlestirme (Hardening) Ifadeleri
 *
 * Prisma migration'lari semayi olusturur; ancak asagidaki kisitlar Prisma
 * semasinda ifade edilemez. Bunlar her migration sonrasi idempotent olarak
 * uygulanir (`pnpm --filter @toptanportal/db harden`).
 *
 * NOT: Prisma extended protocol kullandigi icin cok ifadeli SQL bloklarini tek
 * seferde calistiramaz. Bu yuzden ifadeler dizi halinde tutulur ve sirayla
 * yurutulur. Her ifade tekrar calistirilmaya dayaniklidir (IF NOT EXISTS /
 * CREATE OR REPLACE / DO bloklari).
 */

export const HARDENING_STATEMENTS: readonly { name: string; sql: string }[] = [
  // -------------------------------------------------------------------------
  // 1) audit_logs: APPEND-ONLY (5651 ve 5070 sayili kanunlar)
  //    Uygulama kullanicisi dahil hic kimse gecmis kaydi degistiremez/silemez.
  // -------------------------------------------------------------------------
  {
    name: 'audit_logs mutation guard function',
    sql: `
CREATE OR REPLACE FUNCTION toptanportal_block_mutation() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION
    'Tablo salt-ekleme modundadir (5651/5070 yasal delil saklama): % islemi reddedildi. Tablo: %',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = '42501';
END;
$fn$ LANGUAGE plpgsql;`,
  },
  {
    name: 'audit_logs UPDATE trigger',
    sql: `
DROP TRIGGER IF EXISTS trg_audit_logs_block_update ON audit_logs;
`,
  },
  {
    name: 'audit_logs UPDATE trigger create',
    sql: `
CREATE TRIGGER trg_audit_logs_block_update
BEFORE UPDATE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION toptanportal_block_mutation();`,
  },
  {
    name: 'audit_logs DELETE trigger drop',
    sql: `DROP TRIGGER IF EXISTS trg_audit_logs_block_delete ON audit_logs;`,
  },
  {
    name: 'audit_logs DELETE trigger create',
    sql: `
CREATE TRIGGER trg_audit_logs_block_delete
BEFORE DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION toptanportal_block_mutation();`,
  },
  {
    name: 'audit_logs TRUNCATE trigger drop',
    sql: `DROP TRIGGER IF EXISTS trg_audit_logs_block_truncate ON audit_logs;`,
  },
  {
    name: 'audit_logs TRUNCATE trigger create',
    sql: `
CREATE TRIGGER trg_audit_logs_block_truncate
BEFORE TRUNCATE ON audit_logs
FOR EACH STATEMENT EXECUTE FUNCTION toptanportal_block_mutation();`,
  },

  // -------------------------------------------------------------------------
  // 2) consent_records: silinemez. (IYS senkron durumu guncellenebilmelidir,
  //    bu yuzden yalnizca DELETE/TRUNCATE engellenir.)
  // -------------------------------------------------------------------------
  {
    name: 'consent_records DELETE trigger drop',
    sql: `DROP TRIGGER IF EXISTS trg_consent_records_block_delete ON consent_records;`,
  },
  {
    name: 'consent_records DELETE trigger create',
    sql: `
CREATE TRIGGER trg_consent_records_block_delete
BEFORE DELETE ON consent_records
FOR EACH ROW EXECUTE FUNCTION toptanportal_block_mutation();`,
  },
  {
    name: 'consent_records TRUNCATE trigger drop',
    sql: `DROP TRIGGER IF EXISTS trg_consent_records_block_truncate ON consent_records;`,
  },
  {
    name: 'consent_records TRUNCATE trigger create',
    sql: `
CREATE TRIGGER trg_consent_records_block_truncate
BEFORE TRUNCATE ON consent_records
FOR EACH STATEMENT EXECUTE FUNCTION toptanportal_block_mutation();`,
  },

  // -------------------------------------------------------------------------
  // 3) Rol <-> Isletme kapsam butunlugu.
  //    Isletme rolleri MUTLAKA bir cariye bagli olmali; toptanci tarafi roller
  //    ise hicbir cariye bagli OLMAMALIDIR. Uygulama katmani hata yapsa bile
  //    veritabani bunu kabul etmez.
  // -------------------------------------------------------------------------
  {
    name: 'users role/company scope check',
    sql: `
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_users_role_company_scope'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT chk_users_role_company_scope CHECK (
      (role::text IN ('BUSINESS_OWNER', 'BUSINESS_STAFF', 'BUSINESS_ACCOUNTANT') AND "companyId" IS NOT NULL)
      OR
      (role::text IN ('SUPER_ADMIN', 'SALES_REP') AND "companyId" IS NULL)
    );
  END IF;
END
$do$;`,
  },

  // -------------------------------------------------------------------------
  // 4) Zincir butunlugu: seq pozitif ve hash alanlari 64 hex karakter olmali.
  // -------------------------------------------------------------------------
  {
    name: 'audit_logs hash format check',
    sql: `
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_audit_logs_hash_format'
  ) THEN
    ALTER TABLE audit_logs ADD CONSTRAINT chk_audit_logs_hash_format CHECK (
      "seq" > 0
      AND hash ~ '^[0-9a-f]{64}$'
      AND "prevHash" ~ '^[0-9a-f]{64}$'
    );
  END IF;
END
$do$;`,
  },

  // -------------------------------------------------------------------------
  // 5) Kredi limiti ve bakiye alanlari negatif limit kabul etmez.
  // -------------------------------------------------------------------------
  {
    name: 'companies credit limit check',
    sql: `
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_companies_credit_limit_non_negative'
  ) THEN
    ALTER TABLE companies ADD CONSTRAINT chk_companies_credit_limit_non_negative
      CHECK ("creditLimit" >= 0 AND "paymentTermDays" >= 0);
  END IF;
END
$do$;`,
  },

  // -------------------------------------------------------------------------
  // 6) Performans indeksleri (Prisma @@index ile ifade edilemeyen kismi/ozel).
  // -------------------------------------------------------------------------
  {
    name: 'sessions active partial index',
    sql: `
CREATE INDEX IF NOT EXISTS idx_sessions_active
ON sessions ("userId", "expiresAt")
WHERE "revokedAt" IS NULL;`,
  },
  {
    name: 'outbox pending partial index',
    sql: `
CREATE INDEX IF NOT EXISTS idx_outbox_pending
ON outbox_events ("nextAttemptAt")
WHERE status IN ('PENDING', 'FAILED');`,
  },
  {
    name: 'users active email lookup index',
    sql: `
CREATE INDEX IF NOT EXISTS idx_users_active_email
ON users ("tenantId", "emailNormalized")
WHERE "deletedAt" IS NULL;`,
  },
  {
    name: 'trusted devices validity index',
    sql: `
CREATE INDEX IF NOT EXISTS idx_trusted_devices_valid
ON trusted_devices ("userId", "deviceIdHash", "trustedUntil")
WHERE "revokedAt" IS NULL;`,
  },
];
