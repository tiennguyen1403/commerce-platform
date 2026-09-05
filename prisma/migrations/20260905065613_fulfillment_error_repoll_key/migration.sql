-- Round-robin re-poll key for the deprioritised ERRORING poll tier (M4 #175), the erroring-
-- tier analogue of #164's `fulfillmentStuckPolledAt`. Nullable, no default → additive and safe
-- on the non-empty `Order` table (golden rule 6).
-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "fulfillmentErrorPolledAt" TIMESTAMP(3);

-- Backfill: seed the re-poll key = `updatedAt` for every already-erroring row (an erroring
-- order's last write is its last failed getTracking poll, so `updatedAt` ≈ its last error poll),
-- so the invariant "fulfillmentErrorPolledAt is non-null IFF fulfillmentErrorCount > 0" holds
-- from the first post-deploy poll. Without it, an existing erroring row (count > 0, null re-poll
-- key) would sort into the FRESH tier once — momentarily reintroducing the exact fresh-order
-- starvation #170 fixed (an erroring order jumping ahead of fresh ones) — until its next error
-- poll stamped the key. Touches only rows with a live error streak (typically zero); a no-op on
-- any DB with none.
UPDATE "Order" SET "fulfillmentErrorPolledAt" = "updatedAt" WHERE "fulfillmentErrorCount" > 0;
