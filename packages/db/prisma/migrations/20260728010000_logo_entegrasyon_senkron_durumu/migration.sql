-- CreateEnum
CREATE TYPE "SyncChannel" AS ENUM ('STOCK', 'PRICE', 'ACCOUNT', 'ORDER');

-- CreateTable
CREATE TABLE "sync_cursors" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "channel" "SyncChannel" NOT NULL,
    "cursor" VARCHAR(120) NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSuccessAt" TIMESTAMPTZ(6),
    "lastAttemptAt" TIMESTAMPTZ(6),
    "lastError" VARCHAR(1000),
    "lastItemCount" INTEGER NOT NULL DEFAULT 0,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lockedBy" VARCHAR(64),
    "lockedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sync_cursors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bridge_health_checks" (
    "id" BIGSERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "version" VARCHAR(32),
    "logoServiceUp" BOOLEAN NOT NULL,
    "databaseUp" BOOLEAN NOT NULL,
    "companyNumber" INTEGER,
    "periodNumber" INTEGER,
    "message" VARCHAR(500),
    "latencyMs" INTEGER,
    "checkedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bridge_health_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sync_cursors_tenantId_channel_key" ON "sync_cursors"("tenantId", "channel");

-- CreateIndex
CREATE INDEX "bridge_health_checks_tenantId_checkedAt_idx" ON "bridge_health_checks"("tenantId", "checkedAt");

-- AddForeignKey
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bridge_health_checks" ADD CONSTRAINT "bridge_health_checks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Mevcut kiracilar icin dort kanalin imleci pesinen acilir; boylece kurulumdan
-- hemen sonraki ilk turda yonetim ekrani bos gorunmez.
--
-- Sonradan olusan kiracilarda satiri servis `upsert` ile acar: iki isleyicinin
-- ayni anda baslamasi durumunda unique kisit yarisi kaybedeni de dogru sonuca
-- goturur, "unique violation" hatasi uretmez.
INSERT INTO "sync_cursors" ("id", "tenantId", "channel", "updatedAt")
SELECT gen_random_uuid(), t."id", c."channel", NOW()
FROM "tenants" t
CROSS JOIN (
  SELECT unnest(ARRAY['STOCK', 'PRICE', 'ACCOUNT', 'ORDER']::"SyncChannel"[]) AS "channel"
) c;
