-- CreateEnum
CREATE TYPE "EDocumentKind" AS ENUM ('EINVOICE', 'EARCHIVE', 'EDESPATCH');

-- CreateEnum
CREATE TYPE "EDocumentStatus" AS ENUM ('DRAFT', 'SENT', 'DELIVERED', 'ACCEPTED', 'REJECTED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "e_documents" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "kind" "EDocumentKind" NOT NULL,
    "status" "EDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "documentNumber" VARCHAR(20) NOT NULL,
    "uuid" UUID NOT NULL,
    "issueDate" DATE NOT NULL,
    "netAmount" DECIMAL(18,4) NOT NULL,
    "vatAmount" DECIMAL(18,4) NOT NULL,
    "grandTotal" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'TRY',
    "orderId" UUID,
    "entryId" UUID,
    "despatchDate" DATE,
    "responseNote" VARCHAR(500),
    "respondedAt" TIMESTAMPTZ(6),
    "xmlPath" VARCHAR(500) NOT NULL,
    "pdfPath" VARCHAR(500),
    "envelopePath" VARCHAR(500),
    "contentHash" CHAR(64) NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "providerRef" VARCHAR(64),
    "errorMessage" VARCHAR(500),
    "sentAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "e_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "e_document_access" (
    "id" BIGSERIAL NOT NULL,
    "documentId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "format" VARCHAR(10) NOT NULL,
    "ip" VARCHAR(45),
    "accessedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "e_document_access_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "e_documents_entryId_key" ON "e_documents"("entryId");

-- CreateIndex
CREATE UNIQUE INDEX "e_documents_tenantId_uuid_key" ON "e_documents"("tenantId", "uuid");

-- CreateIndex
CREATE UNIQUE INDEX "e_documents_tenantId_documentNumber_key" ON "e_documents"("tenantId", "documentNumber");

-- CreateIndex
CREATE INDEX "e_documents_companyId_issueDate_idx" ON "e_documents"("companyId", "issueDate");

-- CreateIndex
CREATE INDEX "e_documents_tenantId_kind_issueDate_idx" ON "e_documents"("tenantId", "kind", "issueDate");

-- CreateIndex
CREATE INDEX "e_documents_tenantId_status_idx" ON "e_documents"("tenantId", "status");

-- CreateIndex
CREATE INDEX "e_document_access_documentId_accessedAt_idx" ON "e_document_access"("documentId", "accessedAt");

-- CreateIndex
CREATE INDEX "e_document_access_userId_accessedAt_idx" ON "e_document_access"("userId", "accessedAt");

-- AddForeignKey
ALTER TABLE "e_documents" ADD CONSTRAINT "e_documents_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "e_documents" ADD CONSTRAINT "e_documents_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "e_documents" ADD CONSTRAINT "e_documents_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "e_documents" ADD CONSTRAINT "e_documents_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "account_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "e_document_access" ADD CONSTRAINT "e_document_access_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "e_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "e_document_access" ADD CONSTRAINT "e_document_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- e-Belge SILINEMEZ ve GECMISI DEGISTIRILEMEZ.
--
-- VUK 253 belgenin 10 yil saklanmasini zorunlu kilar. Uygulama kullanicisinin
-- yanlislikla veya kotu niyetle silmesini engellemek icin karar veritabanina
-- birakilir: uygulama katmanindaki bir kontrol, yeni yazilan bir sorguyla veya
-- dogrudan baglanan bir arac ile atlanabilir.
--
-- Belgenin PARASAL alanlari ve hukuki asli (xmlPath, uuid, contentHash) da
-- degistirilemez; yalnizca DURUM ilerleyebilir. Alicinin faturayi reddetmesi
-- bir durum degisikligidir, tutarin duzeltilmesi degildir - duzeltme ancak
-- iade faturasiyla yapilir.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION prevent_edocument_tampering()
RETURNS TRIGGER AS $$
BEGIN
    IF (TG_OP = 'DELETE') THEN
        RAISE EXCEPTION 'e-Belge silinemez (VUK 253: 10 yil saklama zorunlulugu).';
    END IF;

    IF (NEW."uuid" IS DISTINCT FROM OLD."uuid"
        OR NEW."documentNumber" IS DISTINCT FROM OLD."documentNumber"
        OR NEW."xmlPath" IS DISTINCT FROM OLD."xmlPath"
        OR NEW."contentHash" IS DISTINCT FROM OLD."contentHash"
        OR NEW."netAmount" IS DISTINCT FROM OLD."netAmount"
        OR NEW."vatAmount" IS DISTINCT FROM OLD."vatAmount"
        OR NEW."grandTotal" IS DISTINCT FROM OLD."grandTotal"
        OR NEW."issueDate" IS DISTINCT FROM OLD."issueDate") THEN
        RAISE EXCEPTION 'e-Belgenin tutar, tarih ve asil belge alanlari degistirilemez. Duzeltme iade faturasiyla yapilir.';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER e_documents_no_delete
    BEFORE DELETE ON "e_documents"
    FOR EACH ROW EXECUTE FUNCTION prevent_edocument_tampering();

CREATE TRIGGER e_documents_no_tamper
    BEFORE UPDATE ON "e_documents"
    FOR EACH ROW EXECUTE FUNCTION prevent_edocument_tampering();

-- Erisim kaydi da degistirilemez: "bu faturayi kim indirdi" sorusunun cevabi,
-- silinebiliyorsa cevap degildir.
CREATE OR REPLACE FUNCTION prevent_edocument_access_tampering()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'e-Belge erisim kaydi degistirilemez veya silinemez.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER e_document_access_append_only
    BEFORE UPDATE OR DELETE ON "e_document_access"
    FOR EACH ROW EXECUTE FUNCTION prevent_edocument_access_tampering();
