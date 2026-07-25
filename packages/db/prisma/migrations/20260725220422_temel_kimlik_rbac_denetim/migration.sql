-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'SALES_REP', 'BUSINESS_OWNER', 'BUSINESS_STAFF', 'BUSINESS_ACCOUNTANT');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'LOCKED');

-- CreateEnum
CREATE TYPE "MfaMethod" AS ENUM ('TOTP', 'SMS');

-- CreateEnum
CREATE TYPE "ClientPlatform" AS ENUM ('WEB', 'IOS', 'ANDROID');

-- CreateEnum
CREATE TYPE "ConsentType" AS ENUM ('KVKK_CLARIFICATION', 'KVKK_EXPLICIT_CONSENT', 'IYS_SMS', 'IYS_EMAIL', 'IYS_CALL');

-- CreateEnum
CREATE TYPE "ConsentSource" AS ENUM ('WEB', 'IOS', 'SALES_REP', 'MIGRATION');

-- CreateEnum
CREATE TYPE "IysSyncStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'SYNCED', 'FAILED');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'SYSTEM', 'INTEGRATION');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "LoginFailureReason" AS ENUM ('UNKNOWN_EMAIL', 'BAD_PASSWORD', 'ACCOUNT_LOCKED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_INVITED', 'IP_NOT_WHITELISTED', 'MFA_FAILED', 'RATE_LIMITED');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "taxNumber" VARCHAR(11),
    "logoFirmNo" INTEGER NOT NULL DEFAULT 1,
    "logoPeriodNo" INTEGER NOT NULL DEFAULT 1,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Europe/Istanbul',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "companies" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "logoCariCode" VARCHAR(32) NOT NULL,
    "logoCariRef" INTEGER,
    "title" VARCHAR(200) NOT NULL,
    "shortName" VARCHAR(80),
    "taxNumber" VARCHAR(11),
    "taxOffice" VARCHAR(80),
    "gibIdentifier" VARCHAR(20),
    "isEInvoiceUser" BOOLEAN NOT NULL DEFAULT false,
    "phone" VARCHAR(24),
    "email" VARCHAR(254),
    "city" VARCHAR(64),
    "district" VARCHAR(64),
    "address" VARCHAR(500),
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "logoPriceListNo" INTEGER,
    "defaultWarehouseNo" INTEGER NOT NULL DEFAULT 0,
    "creditLimit" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "cachedBalance" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "cachedOverdueAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "cachedOverdueDays" INTEGER NOT NULL DEFAULT 0,
    "riskDataSyncedAt" TIMESTAMPTZ(6),
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,
    "blockReason" VARCHAR(280),
    "paymentTermDays" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "companyId" UUID,
    "email" VARCHAR(254) NOT NULL,
    "emailNormalized" VARCHAR(254) NOT NULL,
    "fullName" VARCHAR(120) NOT NULL,
    "phoneEnc" TEXT,
    "phoneIdx" CHAR(64),
    "passwordHash" TEXT NOT NULL,
    "passwordChangedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "role" "UserRole" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'INVITED',
    "mfaRequired" BOOLEAN NOT NULL DEFAULT false,
    "mfaMethod" "MfaMethod",
    "mfaSecretEnc" TEXT,
    "mfaEnrolledAt" TIMESTAMPTZ(6),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(6),
    "lastLoginAt" TIMESTAMPTZ(6),
    "lastLoginIp" VARCHAR(45),
    "lastLoginCity" VARCHAR(64),
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_spending_limits" (
    "userId" UUID NOT NULL,
    "perOrderLimit" DECIMAL(18,4),
    "dailyLimit" DECIMAL(18,4),
    "monthlyLimit" DECIMAL(18,4),
    "alwaysRequiresApproval" BOOLEAN NOT NULL DEFAULT true,
    "updatedByUserId" UUID,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_spending_limits_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "sales_rep_assignments" (
    "id" UUID NOT NULL,
    "salesRepUserId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "assignedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(6),

    CONSTRAINT "sales_rep_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "refreshTokenHash" CHAR(64) NOT NULL,
    "familyId" UUID NOT NULL,
    "deviceIdHash" CHAR(64) NOT NULL,
    "deviceName" VARCHAR(80) NOT NULL,
    "platform" "ClientPlatform" NOT NULL,
    "appVersion" VARCHAR(32),
    "ip" VARCHAR(45) NOT NULL,
    "userAgent" VARCHAR(512),
    "masqueradeCompanyId" UUID,
    "masqueradeStartedAt" TIMESTAMPTZ(6),
    "masqueradeReason" VARCHAR(280),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "revokedReason" VARCHAR(120),
    "replacedBySessionId" UUID,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trusted_devices" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceIdHash" CHAR(64) NOT NULL,
    "deviceName" VARCHAR(80) NOT NULL,
    "platform" "ClientPlatform" NOT NULL,
    "trustedUntil" TIMESTAMPTZ(6) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenIp" VARCHAR(45),
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trusted_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_recovery_codes" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMPTZ(6),
    "usedIp" VARCHAR(45),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_attempts" (
    "id" BIGSERIAL NOT NULL,
    "tenantId" UUID,
    "emailNormalized" VARCHAR(254) NOT NULL,
    "userId" UUID,
    "success" BOOLEAN NOT NULL,
    "failureReason" "LoginFailureReason",
    "ip" VARCHAR(45) NOT NULL,
    "userAgent" VARCHAR(512),
    "country" VARCHAR(2),
    "city" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_ip_whitelist" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "cidr" VARCHAR(45) NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMPTZ(6),
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "admin_ip_whitelist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_chain_head" (
    "tenantId" UUID NOT NULL,
    "lastSeq" BIGINT NOT NULL DEFAULT 0,
    "lastHash" CHAR(64) NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "audit_chain_head_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "recordedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" "AuditActorType" NOT NULL DEFAULT 'USER',
    "actorUserId" UUID,
    "actorRole" "UserRole",
    "actorEmail" VARCHAR(254),
    "onBehalfOfCompanyId" UUID,
    "companyId" UUID,
    "action" VARCHAR(80) NOT NULL,
    "resourceType" VARCHAR(60),
    "resourceId" VARCHAR(64),
    "outcome" VARCHAR(16) NOT NULL DEFAULT 'SUCCESS',
    "ip" VARCHAR(45),
    "userAgent" VARCHAR(512),
    "requestId" VARCHAR(64),
    "sessionId" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "prevHash" CHAR(64) NOT NULL,
    "hash" CHAR(64) NOT NULL,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_records" (
    "id" BIGSERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "companyId" UUID,
    "type" "ConsentType" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "source" "ConsentSource" NOT NULL,
    "documentVersion" VARCHAR(32) NOT NULL,
    "documentHash" CHAR(64) NOT NULL,
    "ip" VARCHAR(45),
    "userAgent" VARCHAR(512),
    "iysStatus" "IysSyncStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "iysSyncedAt" TIMESTAMPTZ(6),
    "iysError" VARCHAR(500),
    "iysRecipient" VARCHAR(254),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" BIGSERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "aggregateType" VARCHAR(60) NOT NULL,
    "aggregateId" VARCHAR(64) NOT NULL,
    "eventType" VARCHAR(80) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 12,
    "nextAttemptAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" VARCHAR(1000),
    "lockedBy" VARCHAR(64),
    "lockedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "key" VARCHAR(120) NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "endpoint" VARCHAR(200) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "responseCode" INTEGER,
    "responseBody" JSONB,
    "completedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_code_key" ON "tenants"("code");

-- CreateIndex
CREATE INDEX "companies_tenantId_isActive_idx" ON "companies"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "companies_tenantId_city_idx" ON "companies"("tenantId", "city");

-- CreateIndex
CREATE UNIQUE INDEX "companies_tenantId_logoCariCode_key" ON "companies"("tenantId", "logoCariCode");

-- CreateIndex
CREATE INDEX "users_tenantId_role_status_idx" ON "users"("tenantId", "role", "status");

-- CreateIndex
CREATE INDEX "users_companyId_status_idx" ON "users"("companyId", "status");

-- CreateIndex
CREATE INDEX "users_tenantId_phoneIdx_idx" ON "users"("tenantId", "phoneIdx");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenantId_emailNormalized_key" ON "users"("tenantId", "emailNormalized");

-- CreateIndex
CREATE INDEX "sales_rep_assignments_companyId_isActive_idx" ON "sales_rep_assignments"("companyId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "sales_rep_assignments_salesRepUserId_companyId_key" ON "sales_rep_assignments"("salesRepUserId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refreshTokenHash_key" ON "sessions"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_revokedAt_idx" ON "sessions"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "sessions_familyId_idx" ON "sessions"("familyId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "trusted_devices_userId_deviceIdHash_key" ON "trusted_devices"("userId", "deviceIdHash");

-- CreateIndex
CREATE INDEX "mfa_recovery_codes_userId_usedAt_idx" ON "mfa_recovery_codes"("userId", "usedAt");

-- CreateIndex
CREATE INDEX "login_attempts_emailNormalized_createdAt_idx" ON "login_attempts"("emailNormalized", "createdAt");

-- CreateIndex
CREATE INDEX "login_attempts_ip_createdAt_idx" ON "login_attempts"("ip", "createdAt");

-- CreateIndex
CREATE INDEX "login_attempts_createdAt_idx" ON "login_attempts"("createdAt");

-- CreateIndex
CREATE INDEX "admin_ip_whitelist_tenantId_isActive_idx" ON "admin_ip_whitelist"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "admin_ip_whitelist_tenantId_cidr_key" ON "admin_ip_whitelist"("tenantId", "cidr");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_occurredAt_idx" ON "audit_logs"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_action_occurredAt_idx" ON "audit_logs"("tenantId", "action", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorUserId_occurredAt_idx" ON "audit_logs"("actorUserId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_logs_companyId_occurredAt_idx" ON "audit_logs"("companyId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_logs_resourceType_resourceId_idx" ON "audit_logs"("resourceType", "resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_tenantId_seq_key" ON "audit_logs"("tenantId", "seq");

-- CreateIndex
CREATE INDEX "consent_records_userId_type_createdAt_idx" ON "consent_records"("userId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "consent_records_tenantId_iysStatus_idx" ON "consent_records"("tenantId", "iysStatus");

-- CreateIndex
CREATE INDEX "outbox_events_status_nextAttemptAt_idx" ON "outbox_events"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "outbox_events_aggregateType_aggregateId_idx" ON "outbox_events"("aggregateType", "aggregateId");

-- CreateIndex
CREATE INDEX "idempotency_keys_expiresAt_idx" ON "idempotency_keys"("expiresAt");

-- CreateIndex
CREATE INDEX "idempotency_keys_userId_endpoint_idx" ON "idempotency_keys"("userId", "endpoint");

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_spending_limits" ADD CONSTRAINT "user_spending_limits_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_rep_assignments" ADD CONSTRAINT "sales_rep_assignments_salesRepUserId_fkey" FOREIGN KEY ("salesRepUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_rep_assignments" ADD CONSTRAINT "sales_rep_assignments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trusted_devices" ADD CONSTRAINT "trusted_devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_attempts" ADD CONSTRAINT "login_attempts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_ip_whitelist" ADD CONSTRAINT "admin_ip_whitelist_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_chain_head" ADD CONSTRAINT "audit_chain_head_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
