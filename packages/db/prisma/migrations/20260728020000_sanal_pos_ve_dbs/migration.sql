-- CreateEnum
CREATE TYPE "PosTransactionStatus" AS ENUM ('INITIATED', 'SUCCEEDED', 'FAILED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "DbsFileKind" AS ENUM ('DEBT', 'RESULT');

-- CreateEnum
CREATE TYPE "DbsRecordStatus" AS ENUM ('PENDING', 'COLLECTED', 'REJECTED');

-- CreateTable
CREATE TABLE "pos_transactions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "initiatedByUserId" UUID NOT NULL,
    "status" "PosTransactionStatus" NOT NULL DEFAULT 'INITIATED',
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'TRY',
    "installment" INTEGER NOT NULL DEFAULT 1,
    "merchantOrderId" VARCHAR(64) NOT NULL,
    "providerRef" VARCHAR(64),
    "providerCode" VARCHAR(32),
    "authCode" VARCHAR(32),
    "maskedPan" VARCHAR(24),
    "cardBrand" VARCHAR(24),
    "bankName" VARCHAR(80),
    "errorCode" VARCHAR(32),
    "errorMessage" VARCHAR(500),
    "paymentId" UUID,
    "requestedAllocations" JSONB NOT NULL DEFAULT '[]',
    "completedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pos_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dbs_batches" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "bankCode" VARCHAR(8) NOT NULL,
    "kind" "DbsFileKind" NOT NULL,
    "fileName" VARCHAR(160) NOT NULL,
    "recordCount" INTEGER NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'TRY',
    "createdByUserId" UUID NOT NULL,
    "processedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dbs_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dbs_records" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "entryId" UUID NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "dueDate" DATE NOT NULL,
    "status" "DbsRecordStatus" NOT NULL DEFAULT 'PENDING',
    "rejectReason" VARCHAR(280),
    "collectedAt" TIMESTAMPTZ(6),
    "paymentId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dbs_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pos_transactions_paymentId_key" ON "pos_transactions"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "pos_transactions_tenantId_merchantOrderId_key" ON "pos_transactions"("tenantId", "merchantOrderId");

-- CreateIndex
CREATE INDEX "pos_transactions_companyId_createdAt_idx" ON "pos_transactions"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "pos_transactions_tenantId_status_createdAt_idx" ON "pos_transactions"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "dbs_batches_tenantId_createdAt_idx" ON "dbs_batches"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "dbs_records_entryId_batchId_key" ON "dbs_records"("entryId", "batchId");

-- CreateIndex
CREATE INDEX "dbs_records_companyId_status_idx" ON "dbs_records"("companyId", "status");

-- CreateIndex
CREATE INDEX "dbs_records_batchId_status_idx" ON "dbs_records"("batchId", "status");

-- AddForeignKey
ALTER TABLE "pos_transactions" ADD CONSTRAINT "pos_transactions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_transactions" ADD CONSTRAINT "pos_transactions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_transactions" ADD CONSTRAINT "pos_transactions_initiatedByUserId_fkey" FOREIGN KEY ("initiatedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_transactions" ADD CONSTRAINT "pos_transactions_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dbs_batches" ADD CONSTRAINT "dbs_batches_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dbs_batches" ADD CONSTRAINT "dbs_batches_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dbs_records" ADD CONSTRAINT "dbs_records_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "dbs_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dbs_records" ADD CONSTRAINT "dbs_records_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dbs_records" ADD CONSTRAINT "dbs_records_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "account_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dbs_records" ADD CONSTRAINT "dbs_records_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Ayni acik belge, ODENMEMIS bir DBS kaydinda yalnizca BIR kez bulunabilir.
--
-- Tablodaki (entryId, batchId) benzersizligi ayni dosyada tekrari engeller ama
-- ayni faturayi IKI FARKLI dosyaya koymayi engellemez. Bu, bayiden iki kez
-- tahsilat demektir ve geri donusu portalin duzeltebilecegi bir sey degildir:
-- para bankalar arasinda hareket etmistir.
--
-- Kismi indeks yalnizca PENDING kayitlari kapsar; reddedilen bir belge
-- yeniden dosyaya girebilmelidir.
CREATE UNIQUE INDEX "dbs_records_entry_pending_unique"
    ON "dbs_records"("entryId")
    WHERE "status" = 'PENDING';
