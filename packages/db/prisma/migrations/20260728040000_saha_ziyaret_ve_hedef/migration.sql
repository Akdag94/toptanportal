-- CreateEnum
CREATE TYPE "VisitOutcome" AS ENUM ('ORDER_TAKEN', 'NO_ORDER', 'COMPLAINT', 'COLLECTION', 'INTRODUCTION');

-- CreateTable
CREATE TABLE "visit_notes" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "authorUserId" UUID NOT NULL,
    "outcome" "VisitOutcome" NOT NULL,
    "note" VARCHAR(1000) NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "followUpDate" DATE,
    "visitedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_targets" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "salesRepUserId" UUID NOT NULL,
    "period" VARCHAR(7) NOT NULL,
    "targetAmount" DECIMAL(18,4) NOT NULL,
    "commissionRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'TRY',
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sales_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "visit_notes_companyId_visitedAt_idx" ON "visit_notes"("companyId", "visitedAt");

-- CreateIndex
CREATE INDEX "visit_notes_authorUserId_visitedAt_idx" ON "visit_notes"("authorUserId", "visitedAt");

-- CreateIndex
CREATE INDEX "visit_notes_tenantId_followUpDate_idx" ON "visit_notes"("tenantId", "followUpDate");

-- CreateIndex
CREATE UNIQUE INDEX "sales_targets_salesRepUserId_period_key" ON "sales_targets"("salesRepUserId", "period");

-- CreateIndex
CREATE INDEX "sales_targets_tenantId_period_idx" ON "sales_targets"("tenantId", "period");

-- AddForeignKey
ALTER TABLE "visit_notes" ADD CONSTRAINT "visit_notes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_notes" ADD CONSTRAINT "visit_notes_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_notes" ADD CONSTRAINT "visit_notes_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_targets" ADD CONSTRAINT "sales_targets_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_targets" ADD CONSTRAINT "sales_targets_salesRepUserId_fkey" FOREIGN KEY ("salesRepUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Ziyaret notu SILINEMEZ ve METNI DEGISTIRILEMEZ.
--
-- Bir sikayet kaydinin sonradan yok olmasi, musteri iliskisinin gecmisini
-- yeniden yazmaktir. Yanlis yazilan not, duzeltme notuyla kapatilir; takip
-- tarihi ise ilerletilebilir cunku o bir PLANDIR, kayit degil.
CREATE OR REPLACE FUNCTION prevent_visit_note_rewrite()
RETURNS TRIGGER AS $$
BEGIN
    IF (TG_OP = 'DELETE') THEN
        RAISE EXCEPTION 'Ziyaret notu silinemez; duzeltme yeni bir notla yapilir.';
    END IF;

    IF (NEW."note" IS DISTINCT FROM OLD."note"
        OR NEW."outcome" IS DISTINCT FROM OLD."outcome"
        OR NEW."companyId" IS DISTINCT FROM OLD."companyId"
        OR NEW."authorUserId" IS DISTINCT FROM OLD."authorUserId"
        OR NEW."visitedAt" IS DISTINCT FROM OLD."visitedAt") THEN
        RAISE EXCEPTION 'Ziyaret notunun metni ve sahibi degistirilemez.';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER visit_notes_append_only
    BEFORE UPDATE OR DELETE ON "visit_notes"
    FOR EACH ROW EXECUTE FUNCTION prevent_visit_note_rewrite();
