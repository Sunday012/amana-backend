-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "virtualAccountNumber" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "payments_virtualAccountNumber_key" ON "payments"("virtualAccountNumber");
