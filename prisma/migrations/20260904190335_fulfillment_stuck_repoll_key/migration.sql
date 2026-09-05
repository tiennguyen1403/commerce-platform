-- Round-robin re-poll key for the deprioritised flagged-stuck poll tail (M4 #164).
-- Nullable, no default → additive and safe on the non-empty `Order` table (golden rule 6).
-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "fulfillmentStuckPolledAt" TIMESTAMP(3);

-- Backfill: seed the re-poll key = `fulfillmentStuckAt` for every already-flagged row, so
-- the invariant "fulfillmentStuckPolledAt is non-null IFF the order is flagged-stuck" holds
-- from the first post-deploy poll. Without it, existing flagged rows (non-null
-- `fulfillmentStuckAt`, null `fulfillmentStuckPolledAt`) would sort into the not-yet-flagged
-- group once — momentarily reintroducing the exact fresh-order starvation #158 fixed — until
-- their next poll stamped the key. Touches only rows the poll cron has flagged (typically
-- zero); a no-op on any DB with none.
UPDATE "Order" SET "fulfillmentStuckPolledAt" = "fulfillmentStuckAt" WHERE "fulfillmentStuckAt" IS NOT NULL;
