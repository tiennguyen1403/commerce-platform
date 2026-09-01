-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'DEAD');

-- CreateEnum
CREATE TYPE "OutboxMessageType" AS ENUM ('ORDER_CONFIRMATION');

-- CreateTable
CREATE TABLE "OutboxMessage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "OutboxMessageType" NOT NULL,
    "orderId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OutboxMessage_idempotencyKey_key" ON "OutboxMessage"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OutboxMessage_status_nextAttemptAt_idx" ON "OutboxMessage"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OutboxMessage_tenantId_idx" ON "OutboxMessage"("tenantId");

-- CreateIndex
CREATE INDEX "OutboxMessage_orderId_idx" ON "OutboxMessage"("orderId");

-- AddForeignKey
ALTER TABLE "OutboxMessage" ADD CONSTRAINT "OutboxMessage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxMessage" ADD CONSTRAINT "OutboxMessage_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
