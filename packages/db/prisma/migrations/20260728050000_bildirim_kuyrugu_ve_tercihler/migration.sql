-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'PUSH');

-- CreateEnum
CREATE TYPE "NotificationTopic" AS ENUM ('ORDER_STATUS', 'ORDER_APPROVAL_PENDING', 'PAYMENT_RECEIVED', 'DUE_DATE_REMINDER', 'SECURITY', 'INTEGRATION_ALERT');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SUPPRESSED');

-- CreateTable
CREATE TABLE "notification_messages" (
    "id" BIGSERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "topic" "NotificationTopic" NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "recipientUserId" UUID,
    "recipient" VARCHAR(254) NOT NULL,
    "recipientName" VARCHAR(120),
    "subject" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "dedupeKey" VARCHAR(160) NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 6,
    "nextAttemptAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" VARCHAR(1000),
    "suppressedReason" VARCHAR(200),
    "lockedBy" VARCHAR(64),
    "lockedAt" TIMESTAMPTZ(6),
    "relatedType" VARCHAR(40),
    "relatedId" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMPTZ(6),

    CONSTRAINT "notification_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "userId" UUID NOT NULL,
    "topic" "NotificationTopic" NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("userId", "topic", "channel")
);

-- CreateTable
CREATE TABLE "push_devices" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "platform" "ClientPlatform" NOT NULL,
    "token" VARCHAR(255) NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "deviceName" VARCHAR(80),
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_messages_tenantId_dedupeKey_key" ON "notification_messages"("tenantId", "dedupeKey");

-- CreateIndex
CREATE INDEX "notification_messages_status_nextAttemptAt_idx" ON "notification_messages"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "notification_messages_tenantId_createdAt_idx" ON "notification_messages"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "notification_messages_recipientUserId_createdAt_idx" ON "notification_messages"("recipientUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "push_devices_token_key" ON "push_devices"("token");

-- CreateIndex
CREATE INDEX "push_devices_userId_revokedAt_idx" ON "push_devices"("userId", "revokedAt");

-- AddForeignKey
ALTER TABLE "notification_messages" ADD CONSTRAINT "notification_messages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_messages" ADD CONSTRAINT "notification_messages_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- GONDERILMIS BILDIRIM DEGISTIRILEMEZ.
--
-- "Vade hatirlatmasi gonderdik" cumlesi, ancak gonderilen metin sonradan
-- degistirilemiyorsa bir sey ifade eder. Kuyruktaki (PENDING) kayit hala
-- islenmektedir; kisit yalnizca gonderim ANINDAN SONRA baslar.
--
-- Silme ENGELLENMEZ: bildirim yasal saklama yukumlulugu olan bir belge degil,
-- alicinin adresini tasiyan kisisel veridir. KVKK gereginden uzun saklamayi
-- yasaklar; saklama suresi dolan kayitlar bakim goreviyle silinir.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_sent_notification_tampering()
RETURNS TRIGGER AS $$
BEGIN
    IF (OLD."status" = 'SENT' AND (
           NEW."subject" IS DISTINCT FROM OLD."subject"
        OR NEW."body" IS DISTINCT FROM OLD."body"
        OR NEW."recipient" IS DISTINCT FROM OLD."recipient"
        OR NEW."topic" IS DISTINCT FROM OLD."topic"
        OR NEW."channel" IS DISTINCT FROM OLD."channel"
        OR NEW."sentAt" IS DISTINCT FROM OLD."sentAt"
    )) THEN
        RAISE EXCEPTION 'Gonderilmis bildirimin icerigi ve alicisi degistirilemez.';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notification_messages_no_tamper
    BEFORE UPDATE ON "notification_messages"
    FOR EACH ROW EXECUTE FUNCTION prevent_sent_notification_tampering();

-- Kuyruktaki isi ceken sorgunun kismi indeksi.
CREATE INDEX IF NOT EXISTS idx_notification_messages_pending
ON "notification_messages" ("nextAttemptAt")
WHERE "status" = 'PENDING';
