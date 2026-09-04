-- CreateEnum
CREATE TYPE "FulfillmentStatus" AS ENUM ('NOT_SUBMITTED', 'SUBMITTING', 'SUBMITTED', 'SHIPPED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OutboxMessageType" ADD VALUE 'FULFILLMENT_SUBMISSION';
ALTER TYPE "OutboxMessageType" ADD VALUE 'SHIPPING_CONFIRMATION';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "fulfillmentExternalId" TEXT,
ADD COLUMN     "fulfillmentProvider" TEXT,
ADD COLUMN     "fulfillmentProviderStatus" TEXT,
ADD COLUMN     "fulfillmentStatus" "FulfillmentStatus" NOT NULL DEFAULT 'NOT_SUBMITTED',
ADD COLUMN     "shipCity" TEXT,
ADD COLUMN     "shipCountry" TEXT,
ADD COLUMN     "shipLine1" TEXT,
ADD COLUMN     "shipLine2" TEXT,
ADD COLUMN     "shipName" TEXT,
ADD COLUMN     "shipPostalCode" TEXT,
ADD COLUMN     "shipState" TEXT,
ADD COLUMN     "trackingCarrier" TEXT,
ADD COLUMN     "trackingNumber" TEXT,
ADD COLUMN     "trackingUrl" TEXT;

-- AlterTable
ALTER TABLE "ProductVariant" ADD COLUMN     "providerVariantId" TEXT;
