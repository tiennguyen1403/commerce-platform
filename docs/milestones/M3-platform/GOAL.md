# M3 — Platform

Turn the single-store, production-grade app from M2 into a real multi-store
**platform**: every store lives on its own subdomain, anyone can self-serve a new store,
each store themes its own storefront, shoppers sign in and keep an order history, the
catalog is searchable, and the admin gets real time-series analytics.

Scope was fixed at `/milestone-start` (this doc). Technical decisions — the subdomain
scheme, cross-subdomain session strategy, the search implementation, analytics
bucketing — are recorded in [`research.md`](research.md), produced alongside this file.

## Goal

A visitor at `<store>.<app-domain>` sees that store's own themed catalog and can search
it; a shopper can create an account, check out signed-in, and review past orders; a new
merchant can self-serve a store on a fresh subdomain and become its OWNER; and the admin
dashboard shows revenue and orders over time with refunds correctly netted. Everything
stays tenant-isolated, layered (UI → service → repository → Prisma), and money stays
integer cents — the M1/M2 rules are non-negotiable.

## In scope

**1. Multi-store foundation**

- **Subdomain tenant resolution** — resolve the active tenant from the request host
  (`<store>.<app-domain>`), replacing the hard-coded `DEMO_TENANT_SLUG` in
  `src/server/store-context.ts:26`. Unknown subdomain → 404; reserved subdomains
  (`www`, `admin`, `app`, `api`, …) handled; apex/root behavior defined.
- **Self-serve store onboarding** — a signed-in user creates a store: `Tenant` (unique
  slug/subdomain) + `Membership(OWNER)` in one transaction, with slug normalization,
  validation, and reserved-word/collision handling. A user may own **multiple** stores.
- **Tenant-aware admin** — auth/admin/onboarding are centralized on the apex host (no
  cross-subdomain cookies); the admin area is path-scoped **`/admin/[storeSlug]`** with a
  store switcher, and `requireAdminContext(storeSlug)` authorizes the caller's membership
  in the store named on the URL.
- **Per-tenant storefront theming** — each store renders its own accent + branding
  (name, and an OKLCH accent at minimum) via SSR-injected CSS custom properties, on top
  of the existing token system; theme-aware (light/dark), no cross-tenant bleed, invalid
  values fall back safely.

**2. Authenticated shoppers**

- **Customer accounts** — shoppers sign up / sign in on the storefront, without
  clobbering an admin (or another store's) session — see the M2 session-hijack finding.
- **Order ↔ account linking + order history** — orders made while signed in link to the
  shopper; a storefront page lists their orders for that store (scoped by `userId` **and**
  `tenantId`). Guest checkout still works.
- **Close #92** — authenticated checkout binds in-flight PaymentIntent reuse to the
  account, not a client-supplied email string (`order.service.ts:265-320`).

**3. Storefront discovery**

- **Catalog search** — tenant-scoped, `ACTIVE`-only, reflects `available = stock -
reserved`; parameterized (no injection); paginated; a usable storefront search UI.

**4. Real analytics**

- **Time-series charts** — revenue and order counts over time on `/admin`,
  tenant-scoped, no Prisma in the page, accessible and theme-aware, no heavy chart
  dependency without justification.
- **Close #93** — revenue reports gross / refunds / **net**; a `REFUNDED` order is netted
  or labeled, not dropped wholesale (`analytics.repository.ts:39-45`).

## Out of scope (deferred, by design)

- **Stripe Connect / per-store payouts** — reshapes the whole payment layer; deserves
  its own milestone. M3 stays on the single platform Stripe account.
- **Partial refunds + automatic restock on refund** — M3 keeps M2's full-refund-only.
- **Email invitations for non-existing users** — the members page stays
  add-existing-user-only (per the M2 session-hijack finding).
- **Custom / bring-your-own domains** — M3 does `<store>.<app-domain>` subdomains only.
- **Multi-currency conversion, i18n/localization.**
- **A full theme editor** (fonts, layouts, custom CSS) — M3 does a restrained
  accent/brand only.
- **Real fulfilment / shipping / addresses** — that is M4.

## Exit criteria

_Finalized at `/milestone-start`; technical specifics live in `research.md`. Adjust only
with a note here if research forces a change._

- [ ] **Subdomain routing** — `<store>.<app-domain>` renders that store's catalog; an
      unknown subdomain 404s; reserved subdomains are refused as stores; the storefront
      no longer references `DEMO_TENANT_SLUG`. Documented local-dev recipe for
      subdomains.
- [ ] **Onboarding** — a signed-in user self-serves a new store (unique subdomain) and
      becomes its OWNER in one transaction; slug validation + reserved words + collision
      handling enforced server-side; a user can own more than one store.
- [ ] **Tenant-aware admin** — the admin area is path-scoped `/admin/[storeSlug]` with a
      store switcher; `requireAdminContext(storeSlug)` authorizes membership in the store
      on the URL (a non-member is refused); no admin page references `DEMO_TENANT_SLUG`.
- [ ] **Theming** — each store shows its own accent/branding via SSR CSS variables,
      theme-aware, with no cross-tenant bleed; an invalid stored value falls back to the
      default without breaking the page.
- [ ] **Shopper accounts** — a shopper signs up / signs in on the storefront without
      clobbering an admin session; checkout can be completed while authenticated.
- [ ] **Order history** — a signed-in shopper sees their own orders for that store
      (scoped by `userId` **and** `tenantId`); guest checkout still works end to end.
- [ ] **#92 closed** — authenticated checkout binds PaymentIntent reuse to the account,
      not a client-supplied email.
- [ ] **Search** — storefront search returns only this tenant's `ACTIVE` products,
      reflects `available`, is parameterized (no injection), and is paginated.
- [ ] **Analytics time-series** — the admin dashboard and a dedicated
      `/admin/[storeSlug]/analytics` page show revenue + order-count over time,
      tenant-scoped, no Prisma in the page, accessible (labelled, AA contrast) and
      theme-aware in light/dark.
- [ ] **#93 closed** — revenue is reported as gross / refunds / net; a `REFUNDED` order
      is netted or clearly labeled, never silently dropped.
- [ ] **Tests green in CI** — unit/service tests for new service logic, repository
      integration tests for the new raw queries (search, time-series), and Playwright
      E2E for at least one new critical flow (authenticated checkout or onboarding);
      `verify` + `test-db` jobs green.
- [ ] **Quality gates** — `pnpm build`, `pnpm typecheck`, `pnpm lint`, and the full test
      suite green; CI passing on `development`.
- [ ] **Docs** — `research.md` (this milestone), the `docs/ARCHITECTURE.md` decision log,
      and `docs/DATABASE.md` (for schema changes) updated; `handoff.md` at close.

## GitHub

- Milestone: **M3 — platform** (#3).
- Issues labelled `phase:M3`, `type:*`, `area:*`; each ≈ one PR. #92 and #93 are already
  filed under M3 and are closed by the accounts and analytics work respectively.
