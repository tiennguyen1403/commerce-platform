-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "issuer" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Account_issuer_accountId_key" ON "Account"("issuer", "accountId");
