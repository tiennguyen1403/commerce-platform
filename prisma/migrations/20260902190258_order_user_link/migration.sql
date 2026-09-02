-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "userId" TEXT;

-- CreateIndex
CREATE INDEX "Order_tenantId_userId_createdAt_idx" ON "Order"("tenantId", "userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
