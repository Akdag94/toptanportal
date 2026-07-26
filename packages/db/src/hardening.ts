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

  // -------------------------------------------------------------------------
  // 7) Birim cevrim katsayisi SIFIR OLAMAZ.
  //    Sifir katsayi, secilen birimin ana birim karsiligini sifira dusurur;
  //    stoktan hic dusmeyen ama sevk edilen siparis demektir. Uygulama katmani
  //    hata yapsa bile veritabani bunu kabul etmemelidir.
  // -------------------------------------------------------------------------
  {
    name: 'product_units conversion factor check',
    sql: `
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_product_units_conversion_positive'
  ) THEN
    ALTER TABLE product_units ADD CONSTRAINT chk_product_units_conversion_positive
      CHECK ("conversionFactor" > 0);
  END IF;
END
$do$;`,
  },
  {
    name: 'products rate and quantity checks',
    sql: `
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_products_rates_non_negative'
  ) THEN
    ALTER TABLE products ADD CONSTRAINT chk_products_rates_non_negative CHECK (
      "vatRate" >= 0 AND "vatRate" <= 100
      AND "minOrderQuantity" >= 0
      AND ("maxOrderQuantity" IS NULL OR "maxOrderQuantity" >= "minOrderQuantity")
    );
  END IF;
END
$do$;`,
  },

  // -------------------------------------------------------------------------
  // 8) Fiyat ve iskonto siniri.
  //    %100'u asan iskonto negatif tutarli siparis uretir; kademe esigi negatif
  //    olamaz.
  // -------------------------------------------------------------------------
  {
    name: 'price_list_items non-negative check',
    sql: `
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_price_list_items_non_negative'
  ) THEN
    ALTER TABLE price_list_items ADD CONSTRAINT chk_price_list_items_non_negative
      CHECK (price >= 0 AND "minQuantity" >= 0);
  END IF;
END
$do$;`,
  },
  {
    name: 'discount_rules rate bounds check',
    sql: `
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_discount_rules_rate_bounds'
  ) THEN
    ALTER TABLE discount_rules ADD CONSTRAINT chk_discount_rules_rate_bounds CHECK (
      "ratePercent" >= 0 AND "ratePercent" <= 100
      AND "minQuantity" >= 0
      AND "chainOrder" >= 1
    );
  END IF;
END
$do$;`,
  },

  // -------------------------------------------------------------------------
  // 9) Stok defteri butunlugu.
  //    portalReserved yalnizca portalin kendi tuttugu rezervlerin toplamidir;
  //    negatife dusmesi, bir rezervin IKI KEZ serbest birakildigini gosterir.
  //    Bu durumda stok oolmadigi halde var gorunur.
  // -------------------------------------------------------------------------
  {
    name: 'stock_snapshots reserved non-negative check',
    sql: `
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_stock_snapshots_reserved_non_negative'
  ) THEN
    ALTER TABLE stock_snapshots ADD CONSTRAINT chk_stock_snapshots_reserved_non_negative
      CHECK ("portalReserved" >= 0 AND "logoReserved" >= 0);
  END IF;
END
$do$;`,
  },
  {
    name: 'stock_reservations quantity check',
    sql: `
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_stock_reservations_quantity_positive'
  ) THEN
    ALTER TABLE stock_reservations ADD CONSTRAINT chk_stock_reservations_quantity_positive
      CHECK (quantity > 0);
  END IF;
END
$do$;`,
  },

  // -------------------------------------------------------------------------
  // 10) Siparis belgesi kendi icinde tutarli olmalidir.
  //     net = brut - iskonto ve satir toplami = net + KDV esitlikleri, belgeyi
  //     sonradan okuyan denetcinin yapacagi ilk kontroldur. Hatali bir yazici
  //     kod bu esitligi bozarsa kayit hic olusmamalidir.
  // -------------------------------------------------------------------------
  {
    name: 'order_lines arithmetic integrity check',
    sql: `
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_order_lines_arithmetic'
  ) THEN
    ALTER TABLE order_lines ADD CONSTRAINT chk_order_lines_arithmetic CHECK (
      quantity > 0
      AND "baseQuantity" > 0
      AND "conversionFactor" > 0
      AND "discountTotal" >= 0
      AND "unitPrice" >= 0
      AND "netAmount" = "grossAmount" - "discountTotal"
      AND "lineTotal" = "netAmount" + "vatAmount"
    );
  END IF;
END
$do$;`,
  },
  {
    name: 'orders totals integrity check',
    sql: `
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_orders_totals'
  ) THEN
    ALTER TABLE orders ADD CONSTRAINT chk_orders_totals CHECK (
      "grossTotal" >= 0
      AND "discountTotal" >= 0
      AND "netTotal" = "grossTotal" - "discountTotal"
      AND "grandTotal" = "netTotal" + "vatTotal"
    );
  END IF;
END
$do$;`,
  },
  {
    name: 'cart_items quantity check',
    sql: `
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_cart_items_quantity_positive'
  ) THEN
    ALTER TABLE cart_items ADD CONSTRAINT chk_cart_items_quantity_positive
      CHECK (quantity > 0);
  END IF;
END
$do$;`,
  },

  // -------------------------------------------------------------------------
  // 11) Ticari akisin sicak sorgulari icin kismi indeksler.
  // -------------------------------------------------------------------------
  {
    name: 'orders pending approval index',
    sql: `
CREATE INDEX IF NOT EXISTS idx_orders_pending_approval
ON orders ("companyId", "submittedAt")
WHERE status = 'PENDING_APPROVAL';`,
  },
  {
    name: 'stock reservations held index',
    sql: `
CREATE INDEX IF NOT EXISTS idx_stock_reservations_held
ON stock_reservations ("expiresAt")
WHERE status = 'HELD';`,
  },
  {
    name: 'products published catalog index',
    sql: `
CREATE INDEX IF NOT EXISTS idx_products_published
ON products ("tenantId", "sortOrder", name)
WHERE status = 'PUBLISHED';`,
  },
];
