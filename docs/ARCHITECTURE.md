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
- **Subdomains are live (M3):** each store is addressed at its own subdomain
  (`{slug}.{app-domain}`). `src/proxy.ts` resolves the tenant slug from the request
  `Host` header (`src/lib/tenant-host.ts`), strips any inbound `x-tenant-slug` first
  (anti-spoof), and injects the trusted, host-derived value; `getStoreTenant()`
  (`src/server/store-context.ts`) is the sole reader — an unknown slug, the apex host,
  or a reserved word (`www`, `admin`, `api`, …) all 404. Auth, admin, and onboarding
  stay centralized on the platform's **apex** host (`crossSubDomainCookies` off), so a
  store subdomain carries no session authority of its own.
- **Why this model:** simplest to operate solo, cheapest, and still demonstrates real
  platform architecture. Stripe Connect (per-store payouts) remains a deliberately
  deferred upgrade.

## 3. Access control (RBAC)

- Users authenticate via **Better Auth** (email/password now; OAuth later). Auth tables:
  `User`, `Session`, `Account`, `Verification`. One Better Auth instance serves both the
  admin and the storefront; `User.email` is unique platform-wide.
- A **`Membership`** links a `User` to a `Tenant` with a `Role` (`OWNER` > `ADMIN` >
  `STAFF`, see `src/config/roles.ts`). Authorization = "does this user have a membership
  in this tenant with at least role X?". A user may hold memberships in — and so
  administer — more than one tenant.
- **Admin is path-scoped (M3):** `/admin/[storeSlug]`, not a session-pinned single
  store. `requireAdminContext(storeSlug)` (`src/server/auth/admin-context.ts`)
  re-derives the session on every request and authorizes membership in the store named
  on the URL; an unknown store and a store the caller isn't a member of are both a 404,
  indistinguishable from each other.
- **Shoppers are `User`s with no `Membership` (M3)** — signing up on the storefront
  creates an ordinary `User` row with no tenant membership, so it carries no admin
  authority anywhere. `Order.userId` (nullable FK, `onDelete: SetNull`) links an order
  to the signed-in shopper; a shopper's order history is scoped by **both** `tenantId`
  and `userId`, never `tenantId` alone.
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
- **Subdomain tenant resolution — "Model A"** (M3) — the tenant is resolved from the
  request `Host` in the proxy, which strips any inbound `x-tenant-slug` before
  injecting the trusted, host-derived one (anti-spoof); `getStoreTenant()` is the sole
  reader. Auth, admin, and onboarding are centralized on the **apex** host so cookies
  stay host-scoped (`crossSubDomainCookies` off). A bare-loopback→`demo` fallback,
  keyed on `NEXT_PUBLIC_APP_URL` being localhost, keeps local dev and Playwright
  working; it's off in production.
- **Path-scoped admin `/admin/[storeSlug]` + `requireAdminContext(storeSlug)`** (M3) —
  a user may own many stores, so authorization re-checks membership against the store
  named on the URL rather than a session-pinned tenant. A non-member and an unknown
  store are both a 404, indistinguishable — bookmarkable, no hidden session state.
- **Per-tenant theming via SSR-injected, scoped `<style>`** (M3) — `Tenant.themeHue`
  (an `Int`, validated 0–359 with a safe fallback) is scoped to `[data-tenant-theme]`
  (plus a portal marker for body-portaled overlays), rendered with native `oklch()`,
  and theme-aware; no `:root` bleed.
- **Shoppers reuse the global `User` model** (M3) — a shopper is a `User` with no
  `Membership`; one Better Auth instance serves admin and shoppers alike, and email is
  unique platform-wide (a documented trade-off). `Order.userId` is a nullable FK
  (`SetNull`); orders stay tenant-scoped regardless.
- **#92 identity binding** (M3) — in-flight PaymentIntent reuse binds to the
  session-proven `userId`; the guest branch requires `userId: null` in the `WHERE`
  (a discriminated union), so a guest-supplied email can't match a signed-in shopper's
  PENDING order — closes #92 without regressing guest reuse (#25, M2).
- **Catalog search = raw-SQL `tsvector` + GIN** (M3), not Prisma's preview Postgres
  full-text-search API — a `GENERATED … STORED` column plus a GIN index, queried with
  `websearch_to_tsquery` through a parameterized tagged-template `$queryRaw`; ids are
  hydrated via a second tenant-scoped `findMany` re-ordered in JS. Reads
  `available = stock - reserved`.
- **Analytics: raw-SQL `date_trunc` day-buckets (UTC), zero-filled in the service;
  #93's net-revenue model** (M3) — `grossCents` sums every captured order status
  (PAID, FULFILLED, and REFUNDED), `netCents = gross − refunded`, so a refund is
  netted rather than dropping its order from revenue wholesale. Charts are
  **hand-rolled inline SVG** (server-rendered, zero client JS, theme-token colors,
  `sr-only` table fallback), not a charting library — Recharts needs a React 19
  `react-is` override, is client-only, and pulls ~50KB for two small charts.
- **The `?redirect=` open-redirect guard validates the value it _returns_, not just
  the parsed input** (M3, #127) — normalization can turn an on-origin parse into a
  protocol-relative _result_ (`"/..//evil.com"` → `"//evil.com"`); the guard now
  re-resolves the returned path the way the router will and rejects it if that no
  longer lands on the same origin.
- **Multi-currency fulfillment: send the packing-slip display currency; defer per-store
  settlement** (M4, #157) — the per-item retail prices we print on the Printful slip (#148)
  are framed in the order's own currency via Printful v1's `retail_costs.currency`, the
  _only_ per-order currency lever the API exposes (there is no top-level order `currency`
  field). Without it, a tenant whose `Tenant.currency` differs from the single platform
  Printful store's default gets a numerically-correct but wrong-currency slip. We send
  currency **only** — no `subtotal`/`shipping`/`tax`: it relabels the slip without
  reintroducing the aggregate-cost breakdown #148 deferred (a partial one would misstate the
  totals), and Printful still bills the store owner in the store's own currency (the
  read-only `costs`). True per-currency _settlement_ — a Printful store per currency, or
  Stripe Connect payouts — stays the deferred single-account upgrade (see §2, "Stripe
  Connect remains a deliberately deferred upgrade").

Update this log whenever a structural decision is made (the `scribe` agent owns this).
