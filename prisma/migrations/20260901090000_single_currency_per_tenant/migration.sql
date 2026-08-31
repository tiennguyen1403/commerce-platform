-- AlterTable
ALTER TABLE "ProductVariant" DROP COLUMN "currency";

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'usd';
