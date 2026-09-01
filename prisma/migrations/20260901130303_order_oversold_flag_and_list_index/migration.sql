-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "oversold" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Order_tenantId_createdAt_idx" ON "Order"("tenantId", "createdAt");
