-- DropIndex
DROP INDEX "evidence_type_externalId_key";

-- CreateIndex
CREATE UNIQUE INDEX "evidence_agreementId_type_externalId_key" ON "evidence"("agreementId", "type", "externalId");

