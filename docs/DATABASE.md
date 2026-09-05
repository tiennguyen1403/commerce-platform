# Database & migrations

Operational reference for schema changes and safe deploys. `CLAUDE.md` holds the enforced
rules (golden rule 6); this document explains the migration-safety **convention**, the
**guard** that enforces it, and the **recovery path** when a migration can't run against a
database that already holds data.

## Migration conventions

- **Forward-only on shared branches.** Create migrations with `pnpm db:migrate --name
<change>`, review the generated SQL, and never edit one that has been applied or merged.
- **A new `NOT NULL` column on a table that may hold rows must ship with a `DEFAULT`.**
  Postgres uses the default to backfill existing rows, so the add succeeds whether the
  table is empty or not. If you don't want the default to stay, drop it in a follow-up
  migration once every row has a value. (Nullable columns — and columns added to a table
  that is _created in the same migration_ — are always safe.)
- **The guard.** `pnpm db:check-migrations` (`scripts/check-migrations.ts`) scans every
  `prisma/migrations/**/migration.sql` and fails if any `ADD COLUMN … NOT NULL` lacks a
  `DEFAULT`. It reads the raw SQL only — no database, no Prisma engine — and runs in CI, so
  the mistake is caught in the PR, before it can reach a deploy.

### Why this matters

`ALTER TABLE … ADD COLUMN … NOT NULL` with no default **fails on a non-empty table**
(`ERROR: column "…" of relation "…" contains null values`). A _fresh_ deploy passes because
migrations replay in order while the table is still empty; the failure only appears when
`prisma migrate deploy` runs against an environment whose table already held rows — i.e.
staging/production, not a clean local DB. The `single_currency_per_tenant` migration shows
the safe form: `ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'usd'`.

### Adding columns & enum values (the M4 fulfillment migrations)

M4 shipped in **six** forward-only migrations, not the one originally planned — a direct
artifact of the milestone growing from 9 planned issues to 21 as the poll-fulfillment
cron's failure taxonomy grew (see `docs/milestones/M4-fulfillment/handoff.md`, "Why the
milestone grew from 9 to 21 issues"). Every one is additive by construction, so each
applies cleanly to the non-empty `Order`/`ProductVariant` tables with no manual backfill
_required_ — though two of the later ones carry an optional backfill `UPDATE` anyway, for
a reason that isn't the `NOT NULL` guard (see below).

`20260904042456_fulfillment` is the base migration — the canonical _additive_ change:

- **Nullable columns** always backfill as `NULL`: `Order.shipName … shipCountry`,
  `fulfillmentProvider`, `fulfillmentExternalId`, `fulfillmentProviderStatus`,
  `trackingCarrier` / `trackingNumber` / `trackingUrl`, and
  `ProductVariant.providerVariantId`.
- **A `NOT NULL` column needs a `DEFAULT`.** The only one here, `fulfillmentStatus`, ships
  `NOT NULL` with a `DEFAULT` of `'NOT_SUBMITTED'`, so `pnpm db:check-migrations` passes and
  existing PAID/FULFILLED rows backfill to `NOT_SUBMITTED`.
- **A new enum and new enum values are additive too:** creating `FulfillmentStatus` and
  `ALTER TYPE "OutboxMessageType" ADD VALUE` (×2 — `FULFILLMENT_SUBMISSION` +
  `SHIPPING_CONFIRMATION`) touch no rows. Prisma warns that PostgreSQL **11 and earlier**
  can't add more than one enum value in a single migration; we run **16**, so both values
  ship in one file. Removing or renaming an enum value **is** destructive — hand-author it
  and follow `/db-change`, the same as a column drop.

Five more migrations followed as the poll cron's failure taxonomy (terminal-fail,
stuck-open-shipment, tracking-erroring) grew its own alerting and fairness columns, each
landing exactly one additive change:

| Migration                                     | Adds                                              | Safety                              |
| --------------------------------------------- | ------------------------------------------------- | ----------------------------------- |
| `20260904135354_order_fulfillment_stuck_at`   | `Order.fulfillmentStuckAt TIMESTAMP(3)`           | nullable, no default                |
| `20260904155233_order_poll_fulfillment_index` | `@@index([fulfillmentStatus, status])` on `Order` | index only, no column — always safe |
| `20260904180233_add_fulfillment_error_count`  | `Order.fulfillmentErrorCount INTEGER`             | `NOT NULL DEFAULT 0`                |
| `20260904190335_fulfillment_stuck_repoll_key` | `Order.fulfillmentStuckPolledAt TIMESTAMP(3)`     | nullable, no default                |
| `20260905065613_fulfillment_error_repoll_key` | `Order.fulfillmentErrorPolledAt TIMESTAMP(3)`     | nullable, no default                |

**A nullable column can still need a backfill — for an invariant, not for `NOT NULL`.**
The last two migrations above each ship an `UPDATE` alongside their nullable `ADD COLUMN`,
because the column doubles as a **round-robin re-poll key** whose service-layer invariant
is "non-null if and only if the order is in that state" (`fulfillmentStuckPolledAt`
non-null iff flagged-stuck; `fulfillmentErrorPolledAt` non-null iff
`fulfillmentErrorCount > 0`). Left at its default `NULL`, a pre-existing flagged/erroring
row would sort into the poll's _not-yet-flagged_ group for one run after deploy — a brief
reintroduction of the exact re-poll starvation the key exists to fix (#158/#170). The
migration-safety guard doesn't require this backfill (it only checks for a missing
`DEFAULT` on a `NOT NULL` add, and both columns here are nullable regardless) — it's the
correct additive pattern for "keep a value the service logic depends on consistent from row
one," not just "don't fail `migrate deploy`":

```sql
UPDATE "Order" SET "fulfillmentStuckPolledAt" = "fulfillmentStuckAt"
  WHERE "fulfillmentStuckAt" IS NOT NULL;

UPDATE "Order" SET "fulfillmentErrorPolledAt" = "updatedAt"
  WHERE "fulfillmentErrorCount" > 0;
```

(The second backfill uses `updatedAt` as a stand-in for "last failed poll," since an
erroring order's most recent write _is_ its most recent failed `getTracking` poll.) Both
touch only rows already in that flagged/erroring state — typically zero on any real
database, since the columns land before any order reaches those states in practice.

Per-field intent lives in `prisma/schema.prisma`'s comments; the fulfillment behaviour these
columns support is in `docs/ARCHITECTURE.md` §6 and `docs/milestones/M4-fulfillment/`.

## Deploying onto a database seeded before a migration

If `prisma migrate deploy` aborts with `column "…" contains null values` (and blocks later
deploys with `P3009 … failed migrations`), an unsafe migration is trying to run against a
populated table. Pick the path that matches the environment.

### Path A — disposable data (local / throwaway staging)

Replay every migration from an empty database, then reseed:

```bash
pnpm prisma migrate reset --force   # drops the DB, re-applies ALL migrations, runs the seed
```

Because the migrations replay in order on an empty schema, each `NOT NULL` add lands while
its table is still empty and never fails. **`--force` skips the confirmation and all data
is lost** — never run this against data you need to keep. (`--skip-seed` opts out of the
reseed.)

### Path B — preserve existing rows (production-like)

Apply the column change by hand (add nullable → backfill → enforce `NOT NULL`), then tell
Prisma the migration is done so `deploy` skips its SQL and continues with the rest. Worked
example for `20260831105827_account_issuer`:

```sql
BEGIN;
ALTER TABLE "Account" ADD COLUMN "issuer" TEXT;              -- add nullable first
UPDATE "Account" SET "issuer" = 'local:credential'
  WHERE "providerId" = 'credential' AND "issuer" IS NULL;    -- backfill existing rows
-- Sanity check: this MUST return 0 before enforcing NOT NULL.
--   SELECT count(*) FROM "Account" WHERE "issuer" IS NULL;
ALTER TABLE "Account" ALTER COLUMN "issuer" SET NOT NULL;
CREATE UNIQUE INDEX "Account_issuer_accountId_key"
  ON "Account"("issuer", "accountId");
COMMIT;
```

```bash
# Record the migration as applied WITHOUT re-running its (failing) SQL, then continue.
pnpm prisma migrate resolve --applied 20260831105827_account_issuer
pnpm prisma migrate deploy
pnpm prisma migrate status   # verify: no failed or pending migrations
```

**The backfill value is not arbitrary.** Better Auth 1.7 scopes account identity by
`issuer`, and at sign-in it matches a credential account on `providerId = "credential"`
**and** `issuer`. The value it writes for email/password accounts is
`createLocalAccountIssuer("credential")` → **`local:credential`** (see `@better-auth/core`
`src/db/schema/account.ts`: `` `local:${encodeURIComponent(providerId)}` ``). Backfilling
any other value would leave existing users unable to sign in. No OAuth providers are
configured yet; an OAuth account would instead use `local:oauth:<providerId>`.

> Postgres DDL is transactional, so the migration that failed with "contains null values"
> rolled back cleanly and left no partial `issuer` column behind — the manual
> `ADD COLUMN "issuer" TEXT` above starts from a clean slate.

## Why `account_issuer` is grandfathered in the guard

`20260831105827_account_issuer` shipped the unsafe pattern before the guard existed. It is
applied and forward-only, so it can't be edited — the guard allow-lists it (`GRANDFATHERED`
in `scripts/check-migrations.ts`) to keep CI green. Fresh deploys are unaffected; only a
database seeded _before_ this migration needs Path A or Path B above. **Don't extend the
allow-list** — give new `NOT NULL` columns a `DEFAULT` instead.
