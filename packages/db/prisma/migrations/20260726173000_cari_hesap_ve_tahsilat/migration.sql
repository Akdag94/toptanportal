-- CreateEnum
CREATE TYPE "AccountEntryKind" AS ENUM ('OPENING', 'INVOICE', 'RETURN', 'PAYMENT', 'CREDIT_NOTE', 'DEBIT_NOTE');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'CREDIT_CARD', 'CHEQUE', 'PROMISSORY_NOTE', 'DBS');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "account_entries" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "kind" "AccountEntryKind" NOT NULL,
    "entryDate" DATE NOT NULL,
    "dueDate" DATE,
    "documentNumber" VARCHAR(32) NOT NULL,
    "description" VARCHAR(280),
    "debit" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "openAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'TRY',
    "logoFicheRef" INTEGER,
    "logoSyncedAt" TIMESTAMPTZ(6),
    "orderId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "account_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'TRY',
    "receivedAt" TIMESTAMPTZ(6) NOT NULL,
    "reference" VARCHAR(64),
    "note" VARCHAR(280),
    "recordedByUserId" UUID NOT NULL,
    "isFieldCollection" BOOLEAN NOT NULL DEFAULT false,
    "providerRef" VARCHAR(64),
    "failureReason" VARCHAR(280),
    "entryId" UUID,
    "confirmedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "entryId" UUID NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "account_entries_companyId_entryDate_idx" ON "account_entries"("companyId", "entryDate");

-- CreateIndex
CREATE INDEX "account_entries_companyId_dueDate_idx" ON "account_entries"("companyId", "dueDate");

-- CreateIndex
CREATE INDEX "account_entries_tenantId_companyId_createdAt_idx" ON "account_entries"("tenantId", "companyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "account_entries_tenantId_logoFicheRef_key" ON "account_entries"("tenantId", "logoFicheRef");

-- CreateIndex
CREATE UNIQUE INDEX "payments_entryId_key" ON "payments"("entryId");

-- CreateIndex
CREATE INDEX "payments_companyId_receivedAt_idx" ON "payments"("companyId", "receivedAt");

-- CreateIndex
CREATE INDEX "payments_tenantId_status_receivedAt_idx" ON "payments"("tenantId", "status", "receivedAt");

-- CreateIndex
CREATE INDEX "payments_recordedByUserId_receivedAt_idx" ON "payments"("recordedByUserId", "receivedAt");

-- CreateIndex
CREATE INDEX "payment_allocations_entryId_idx" ON "payment_allocations"("entryId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_allocations_paymentId_entryId_key" ON "payment_allocations"("paymentId", "entryId");

-- AddForeignKey
ALTER TABLE "account_entries" ADD CONSTRAINT "account_entries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_entries" ADD CONSTRAINT "account_entries_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "account_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "account_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

