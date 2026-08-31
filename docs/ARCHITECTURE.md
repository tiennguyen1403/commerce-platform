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

## 8. Decision log

- **Next fullstack (not a separate API) for now** — velocity; the clean service/repository
  split lets us extract a NestJS API later if a backend-heavy role calls for it.
- **Prisma over Drizzle** — DX and migrations; revisit only if we hit a real perf ceiling.
- **Better Auth (self-managed) over Clerk** — demonstrates auth/session/RBAC understanding.
- **Money as integer cents** — avoid floating-point money bugs.

Update this log whenever a structural decision is made (the `scribe` agent owns this).
