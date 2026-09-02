# Architecture

Reference for how the platform is put together. `CLAUDE.md` holds the enforced rules; this
document explains the reasoning and the moving parts.

## 1. Shape

A single Next.js 16 app serves both the **storefront** (public, SEO-critical → SSR/ISR)
and the **admin** (authenticated dashboard), plus **API route handlers** (auth, health,
Stripe webhooks). The backend lives in `src/server/**` and is layered:

```
Page / Route handler / Server Action
        │  (calls)
        ▼
     Service            business logic, validation, orchestration
        │  (calls)
        ▼
     Repository         data access — ALWAYS scoped by tenantId
        │
        ▼
      Prisma  →  PostgreSQL
```

Rules: pages/routes never touch Prisma directly; only repositories do. Components never
import from `src/server/**` — they go through Server Actions or services invoked on the server.

## 2. Multi-tenancy

- **Model:** shared database, shared schema, `tenantId` discriminator column on every
  business table (`Product`, `Order`, …). One store = one `Tenant`.
- **Isolation:** enforced in the repository layer — every read/write is filtered by
  `tenantId`. (Stretch goal: Postgres Row-Level Security for defense in depth.)
- **Why this model:** simplest to operate solo, cheapest, and still demonstrates real
  platform architecture. It upgrades cleanly to per-tenant subdomains + Stripe Connect in
  Phase 3 without a rewrite.

## 3. Access control (RBAC)

- Users authenticate via **Better Auth** (email/password now; OAuth later). Auth tables:
  `User`, `Session`, `Account`, `Verification`.
- A **`Membership`** links a `User` to a `Tenant` with a `Role` (`OWNER` > `ADMIN` >
  `STAFF`, see `src/config/roles.ts`). Authorization = "does this user have a membership
  in this tenant with at least role X?".
- A future `platform_admin` (super-admin) operates across tenants.

## 4. Catalog

`Product` → many `ProductVariant`. Variants carry `sku`, `priceCents`, `stock`. Products
have a `status` (`DRAFT` / `ACTIVE` / `ARCHIVED`) and a per-tenant unique `slug`. Currency is
a **store-level** setting (`Tenant.currency`) that every variant inherits — the catalog has
no per-variant currency, so a cart/order can never mix currencies.

## 5. Orders & payments (Phase 1)

- Checkout creates an `Order` (`PENDING`) with `OrderItem`s that **snapshot** title +
  price at purchase time (so later catalog edits never rewrite history).
- Payment via **Stripe** (Payment Intents). The source of truth for "paid" is the Stripe
  **webhook**, not the client redirect. The webhook drives an idempotent order state
  machine: `PENDING → PAID → FULFILLED` (+ `CANCELLED`, `REFUNDED`).
- Money is integer **cents** everywhere. Currency is the store's (`Tenant.currency`); each
  `Order` also snapshots it so a historical total stays correct if the store currency changes.

## 6. Fulfillment

`src/server/fulfillment/provider.ts` defines a `FulfillmentProvider` interface. Concrete
adapters (starting with **Printful** / print-on-demand) implement it. The order flow
depends only on the interface, so suppliers are swappable. POD is preferred over classic
AliExpress dropshipping: real API, faster shipping, less payment-processor risk.

## 7. Environments & config

- `src/lib/env.ts` validates server env once at startup (zod) and is `server-only`.
- Local Postgres via `docker-compose.yml` on host port **55432**.
- Production target: Vercel (app) + Neon/Supabase (Postgres). Prisma client is generated
  in `postinstall` and in CI.
- Migration safety (the `NOT NULL`/`DEFAULT` convention, the CI guard, and how to deploy
  onto a pre-seeded database) lives in [`docs/DATABASE.md`](DATABASE.md).

## 8. Decision log

- **Next fullstack (not a separate API) for now** — velocity; the clean service/repository
  split lets us extract a NestJS API later if a backend-heavy role calls for it.
- **Prisma over Drizzle** — DX and migrations; revisit only if we hit a real perf ceiling.
- **Better Auth (self-managed) over Clerk** — demonstrates auth/session/RBAC understanding.
- **Money as integer cents** — avoid floating-point money bugs.
- **Stripe PaymentIntent + Payment Element (embedded), not hosted Checkout Sessions** (M1)
  — keeps checkout on our own domain and lets the success page verify the PaymentIntent's
  `client_secret` before showing order details; costs more client UI than a Stripe-hosted redirect.
- **Cookie-backed cart, not a DB cart** (M1) — no auth required to shop; the cookie only
  ever stores `{ variantId, qty }`, so price/title/stock/total are always recomputed from
  a live DB read, never trusted from the client.
- **Stripe webhook is the sole writer of "paid," via an idempotent atomic state machine**
  (M1) — `PENDING → PAID` flips only inside a status-guarded transaction (a `PENDING`
  check in the `WHERE`), so retried/duplicate/out-of-order webhook deliveries are safe
  no-ops; the browser redirect never writes order state.
- **Single currency per tenant** (M1) — currency lives on `Tenant`, not `ProductVariant`;
  a store can't accidentally mix currencies in a cart or order total.
- **Static migration-safety guard** (M2) — a `NOT NULL` column added with no `DEFAULT`
  breaks `migrate deploy` on a non-empty table, and applied migrations are forward-only, so
  the fix is prevention: `pnpm db:check-migrations` scans migration SQL in CI and blocks the
  pattern. The pre-existing `account_issuer` case is grandfathered with a documented
  corrective path (`docs/DATABASE.md`, issue #38).
- **Transactional outbox for order-confirmation email, not a direct send from the
  webhook** (M2) — the PENDING → PAID transaction only enqueues an `OutboxMessage`; a
  scheduled drain (with retry/backoff) does the actual send. Delivery is now
  at-least-once instead of at-most-once, and the webhook keeps no blocking network
  call on its response path.
- **Inventory reservation supersedes M1's decrement-at-capture** (M2) — stock is held
  (`ProductVariant.reserved`) at PENDING via an atomic `$executeRaw` guard, released on
  cancel/sweep, and reconciled at PAID; `available = stock - reserved` is now the one
  sellable-units figure every read uses. Oversell at PAID is still possible (rare, not
  eliminated) and stays surfaced, not blocked.
- **Order state machine completed: fulfil, cancel, refund** (M2) — PAID → FULFILLED is
  a manual status attestation only (no fulfilment provider or shipping address until
  M4); PENDING → CANCELLED retires the Stripe PaymentIntent first and flips the DB
  only once it's provably `canceled` (a primitive shared by the abandoned-order sweep
  and the admin cancel action); PAID|FULFILLED → REFUNDED is driven exclusively by the
  Stripe refund webhook — admin-initiated refunds never write the DB directly.
- **RBAC surfaced via `requireRole` (pages, redirects) / `assertRole` (Server Actions,
  throws)** (M2) — server-side defense-in-depth on top of role-aware nav, which is UX
  only. `OWNER > ADMIN > STAFF`; last-owner demotion/removal is guarded by a
  `SELECT … FOR UPDATE` on the tenant's OWNER rows inside one transaction.
- **No Sentry; a thin, swappable `reportError` seam instead** (M2) — `@sentry/nextjs`
  10.38+ crashes in production under Next 16 + Turbopack
  (`getsentry/sentry-javascript#19367`, closed "not planned"). Structured logging is a
  bare `pino()` with no transport, since `pino.transport()`'s worker thread crashes
  under Turbopack too (`vercel/next.js#84766`).
- **Background/periodic work: GitHub Actions `schedule:` (primary) + Vercel Cron
  (backstop)** (M2) — both hit secret-protected `GET /api/cron/*` routes. Vercel
  Hobby cron is capped at once/day (too coarse for the outbox drain/order sweep); GH
  Actions runs every 10 minutes but auto-disables after 60 days of repo inactivity,
  which Vercel Cron covers. `CRON_SECRET` is deliberately outside `env.ts`'s strict
  schema so a missing secret only 401s the cron routes, never blocks boot.
- **`server-only` applied blanket-wide across the db → repository → service layer and
  `auth/index`** (M2) — defense-in-depth so a refactor can never accidentally pull
  server internals into a client bundle.
- **Three-tier Vitest split by filename, not by folder** (M2) — `*.test.ts` (unit,
  mocked repos, zero infra), `*.test.tsx` (dom), `*.integration.test.ts` (real
  Postgres, run serial, throwaway-tenant isolation). `server-only` is aliased to a
  no-op only inside the test runner, never in the real build.

Update this log whenever a structural decision is made (the `scribe` agent owns this).
