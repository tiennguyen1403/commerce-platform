# Research — M3 Platform

> Produced at milestone start (synthesised from three parallel `researcher` passes:
> multi-store plumbing, shopper accounts + search, analytics). Read before building.
> Every claim is backed by code read on the way in (cited `path:line`) or a fresh
> docs/source lookup at the **installed** version. Source code is ground truth.

## Context & goal

M3 turns the M2 single-store, production-grade app into a real multi-store **platform** —
see [`GOAL.md`](GOAL.md). Confirmed scope: per-tenant **subdomains** + self-serve
**onboarding** + per-tenant **theming**; authenticated **shopper accounts** + order
history (closes **#92**); catalog **search**; **analytics** time-series + net-refund fix
(closes **#93**). Stripe Connect and partial refunds are deferred.

**Installed versions (verified from `package.json` + `node_modules`):** `next@16.3.3`,
`react`/`react-dom@19.2.8` (exact-pinned, no caret), `better-auth@1.7.2`,
`@prisma/client`/`prisma@6.19.3`, `zod@4.5.4`, `stripe@22.x`. `schema.prisma:5-7` has **no
`previewFeatures`** on the client generator; `next.config.ts` has **no** `cacheComponents`
(so the classic dynamic-rendering model applies, not Cache Components/PPR).

### Architecture decisions locked at milestone start

1. **Model A — centralize auth/admin/onboarding on the apex host** (`{app-domain}`);
   storefronts live on `{slug}.{app-domain}`. Consequence: **no cross-subdomain cookie
   configuration** is needed — Better Auth's own docs and Vercel both warn against
   widening cookie scope, and the accounts pass reached the same conclusion independently.
2. **Admin becomes tenant-aware via path-scoped `/admin/[storeSlug]` + a store switcher**
   (a user may own many stores). `requireAdminContext(storeSlug)` authorizes membership in
   the store named on the URL — textbook multi-tenant authz, bookmarkable, no hidden
   session state.
3. **Shoppers reuse the global `User` model** (already designed platform-wide,
   `user.repository.ts:5-7`) — no separate `Customer`, no Better Auth `organization`/`admin`
   plugin (they'd duplicate this app's hand-rolled `Tenant`/`Membership`/`Role`).
4. **Search = raw SQL** (generated `tsvector` column + GIN index, `websearch_to_tsquery`
   via parameterized `$queryRaw`) — Prisma's Postgres FTS is preview-only with known drift.
5. **Analytics charts = hand-rolled inline SVG** (server-rendered, zero client JS) — not a
   charting library.

## Key questions (answered below)

- Multi-store: idiomatic host→tenant resolution in Next 16; local-dev subdomains; where
  admin/auth live and whether cookies must span subdomains; one-transaction onboarding
  without the M2 session-hijack bug; per-tenant theming applied SSR with safe fallback.
- Accounts: one Better Auth instance for admin + shoppers?; sign-up/in without cookie
  clobber; `Order.userId`; order history; closing #92 without regressing guest reuse (#25).
- Search: which Postgres FTS mechanism on Prisma 6; migration under the safety guard;
  tenant-scoped ranked query in the repository; storefront UI.
- Analytics: day-bucketing without Prisma `groupBy`; the #93 net-revenue model; bucket
  timezone determinism; charting approach under DESIGN.md's "no heavy deps"; placement.

---

## Findings

### A. Multi-store — subdomains, onboarding, theming

**Framework / APIs (Next 16.3.3, from `node_modules/next/dist/docs/`).**

- **Proxy** (renamed from Middleware in 16.0; `proxy.md:806`) defaults to the Node
  runtime and **must not** set a `runtime` export (`proxy.md:255`). It "is not intended
  for slow data fetching" — the repo's `src/proxy.ts:9-11` already states this. **New
  subdomain logic in the proxy stays DB-free.**
- **Header injection to the RSC tree**: `NextResponse.next({ request: { headers } })`
  forwards headers upstream, readable via `headers()` (`next-response.md:141-159`). The
  plain `next({ headers })` form only reaches the client — do not use it. The docs also
  warn to strip/allow-list inbound `x-*` headers (`next-response.md:173-203`).
- **`headers()` forces dynamic rendering** (`functions/headers.md:48`), and — because
  Cache Components is off — that propagates from a layout to the whole subtree. **Proof in
  repo**: no file under `src/app/(admin)` exports `dynamic`, yet the admin layout's
  `headers()` call (`admin-context.ts:35`) forces the subtree dynamic and works. Once
  `getStoreTenant()` reads `headers()` in `(storefront)/layout.tsx`, the storefront's
  per-page `export const dynamic="force-dynamic"` becomes redundant (harmless; leaving or
  removing is a style call, not correctness).
- **`allowedDevOrigins`** (`config/.../allowedDevOrigins.md`) is required for local
  subdomain dev — Next 16 blocks cross-origin dev-asset requests, so `demo.localhost:3000`
  breaks HMR under `next dev` until `allowedDevOrigins: ["*.localhost"]` is added to
  `next.config.ts`. Does not affect `pnpm start`/Playwright (prod build).

**Better Auth cross-subdomain cookies (from installed 1.7.2 source).** Off by default:
`crossSubdomainEnabled = !!options.advanced?.crossSubDomainCookies?.enabled`
(`cookies/index.mjs:24-26`); cookies are host-scoped (no `Domain`) unless opted in **and**
an explicit apex `domain` is set (`context/helpers.mjs:24-26`). `baseURL` can also be a
`DynamicBaseURLConfig` with `allowedHosts` wildcards for per-request base-URL/trusted-origin
(`init-options.ts:141-188`) — the escape hatch **if** a later milestone wants admin on
subdomains. Better Auth's docs explicitly say "only enable cross-subdomain cookies if
necessary" and "set the domain to the most specific scope." **Decision: leave all of this
untouched in M3** (Model A) — auth/admin on the apex, one host, one cookie jar.

**Vercel multi-tenant guidance (deploy target per `ARCHITECTURE.md:75`, docs current
2026-08).** Canonical proxy pattern = parse `host` → set `x-tenant-*` via
`next({ request: { headers } })` → read with `headers()`. **Mandatory, stated twice:**
_"Tenant headers must come from the proxy, never from the client… delete or overwrite
inbound `x-tenant-*` headers on every path through the proxy."_ Wildcard-subdomain hosting
needs Vercel nameservers + a `*.{domain}` project entry — an **infra prerequisite**, not
app code (no live custom domain found in the repo — flagged, not assumed).

**Patterns to follow.**

- **Two-tier resolution** (mirror the existing auth split): proxy parses `Host`, strips
  inbound `x-tenant-slug`, applies reserved-word/apex routing, injects a trusted
  `x-tenant-slug` (string + `Set` check only, no DB); `getStoreTenant()`
  (`store-context.ts:25-33`) stays the authoritative `cache()` + `notFound()` lookup,
  swapping `DEMO_TENANT_SLUG` for the header value. `cache()`'s per-request dedupe is
  unaffected.
- **Reserved words** as one exported `Set` in `src/config/constants.ts` (next to
  `DEMO_TENANT_SLUG` at `:8`), reused by both proxy (routing) and the onboarding zod
  schema (validation) — never duplicated. Seed: `www, admin, app, api` + defensive
  `static, assets, cdn, docs, blog, mail`. **`demo` must NOT be reserved** (it's a real
  seeded tenant, `prisma/seed.ts:148-150`).
- **Slug validation** reuses `SLUG_PATTERN` `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` from
  `validators/catalog.ts:34`, plus min 3 / max 63 (RFC 1123 DNS label), reserved-word
  check, and DB uniqueness (`Tenant.slug @unique`, `schema.prisma:21`).
- **Onboarding transaction + P2002 translation** mirrors `membership.repository.ts:56-70,
81-109`: `tenantRepository.createWithOwner(data, ownerId)` = `$transaction(tx →
tenant.create then membership.create OWNER)`, catching `P2002` on `slug` →
  `SlugTakenError` (new `src/server/tenant.errors.ts`, modelled on
  `membership.errors.ts`). **Ordering is FK-enforced**: `Membership.userId → User` means
  the account must exist first.
- **Session-hijack avoidance** (`M2 research.md:249-262`): the hijack is specific to
  `auth.api.signUpEmail`/`signInEmail` called **server-side on another identity's behalf**
  (`nextCookies()`'s `after` hook has `matcher → true`, `next-js.mjs:72-99`). Self-service
  sign-up/in is **client-driven** and already safe/shipped (`sign-up-form.tsx:44-54`,
  `authClient.signUp.email`). Onboarding's "create store" is a **separate** Server Action
  that re-derives the session server-side (`auth.api.getSession({ headers })`,
  `admin-context.ts:35`) and never trusts a client-supplied user id.
- **Theming SSR, scoped, no `:root` bleed**: root layout owns `<html>`/`<body>`
  (`app/layout.tsx:26-30`); the three route groups render in `{children}`. Scope the
  accent override to the storefront wrapper `<div>` via a `data-tenant-theme` attribute
  selector (not `:root`) — a structural guarantee it can't reach `(admin)`/`(auth)`.
  Because dark mode is `@media (prefers-color-scheme: dark)` at `:root`
  (`globals.css:4-7,91-125`, **not** a `.dark` class), the override must be an inline
  `<style>` **tag** (attributes can't hold `@media`), re-using the same light/dark L·C
  recipe (`globals.css:63-74` vs `:99-110`) re-parametrised by hue. Native `oklch()` — **no
  `oklchToSrgb`** (that helper exists only for Stripe's cross-origin iframe,
  `color.ts:1-9`).

**Open design questions this raised, and their resolutions.**

- _Multi-store-per-owner admin disambiguation_ → **resolved: path-scoped
  `/admin/[storeSlug]` + switcher** (locked decision #2). `requireAdminContext` becomes
  `requireAdminContext(storeSlug)`, resolving the tenant by the URL slug and asserting the
  caller's membership in it. The whole `/admin` subtree moves under `[storeSlug]`; the
  proxy matcher and admin E2E update accordingly.
- _Apex `/` vs tenant `/`_ → apex `/` (`app/page.tsx`, a splash **outside** the storefront
  group) evolves into the platform landing + "create your store" CTA; a tenant host's `/`
  redirects to `/products` (a dedicated storefront home is deferred).
- _Wildcard-domain hosting_ → documented operator prerequisite (infra), out of app scope.

### B. Authenticated shoppers — accounts, order history, closing #92

**One Better Auth instance serves both** admin and shoppers; **reuse global `User`**
(`user.repository.ts:5-7`: "Users are global… belong to many tenants through Membership").
A shopper is simply a `User` with no `Membership`. Email is unique platform-wide
(`schema.prisma:65`) — a documented trade-off (can't register the same email as unrelated
identities on two stores), acceptable at this scale.

**Sign-up/in stays client-driven and is already safe** (see A's session-hijack note).
Checkout only ever **reads** the session server-side (`getSession`, never a write) — never
call `signUpEmail`/`signInEmail` from a Server Action.

**Concrete snag**: `/sign-in`'s redirect target is hard-allowlisted to `/admin`
(`(auth)/sign-in/page.tsx:13-15`) and the sign-up copy is admin-flavoured — so a shopper
signing in for `/account/orders` would land on `/admin`. **Required change**: broaden the
allowlist to also accept `/account`-prefixed paths, or fork a storefront sign-in/up
surface with its own copy and allowlist.

**Data model**: add `Order.userId String?` + `user User? @relation(..., onDelete:
SetNull)` + `@@index([tenantId, userId, createdAt])` (tenant-leading, per golden rule 1)
and the back-relation `User.orders`. **Nullable → migration is safe** (the guard doesn't
flag it; a normal `pnpm db:migrate`). Identity is platform-wide (the `User`) but orders
stay tenant-scoped by `tenantId` regardless; with Model A (host-scoped cookies) a shopper
signs in per store — realistic and isolated.

**Closing #92 (the real seam, not just "prefer userId")**: thread `userId: string | null`
(resolved **server-side** from the session, never the client) through
`orderService.startCheckout` → `tryReuseInFlightIntent` → `findReusablePendingCandidates`
(`order.service.ts:265-320`, repo `order.repository.ts:312-326`). The WHERE becomes
`{ tenantId, status:"PENDING", currency, totalCents, createdAt:{gte}, ...(userId ?
{ userId } : { userId: null, email }) }`. **The `userId: null` on the guest branch** is
what actually prevents a guest-supplied email from matching a signed-in shopper's PENDING
order; authenticated reuse binds to the session-proven `userId`. Guests otherwise keep
today's behaviour (no #25 regression). Also thread `userId` into `createWithItems`
(`order.repository.ts:191-244`) so new orders record it.

**Order history**: new `orderRepository.listByTenantAndUser` (mirrors `listByTenant`,
`order.repository.ts:511-529`, offset pagination) **and** a new
`findByIdForTenantAndUser` — do **not** reuse `findByIdForTenant` (tenant-only) for a
shopper detail page or it leaks another shopper's order within the tenant. Pages:
`(storefront)/account/orders/page.tsx` (list, redirects to sign-in if no session) and
`.../[id]/page.tsx` (detail, **non-streamed** for a real 404 — no sibling `loading.tsx`,
per the soft-404 gotcha).

### C. Catalog search

**Mechanism = raw SQL tsvector + GIN**, not Prisma FTS: Prisma's `fullTextSearch` is GA
only for MySQL; Postgres needs the separate, still-preview `fullTextSearchPostgres` flag
(off here) and offers no indexed-tsvector/`ts_rank` support. Declaring a generated column
via `Unsupported()` has documented drift bugs (`migrate dev` proposing spurious DROPs —
prisma/prisma#15654, #24496, #14786). Postgres core `tsvector`/GIN needs **no extension**
(unlike `pg_trgm`).

**Migration** via `pnpm prisma migrate dev --name product_search_vector --create-only`
(flag confirmed in the installed CLI), then hand-author:

```sql
ALTER TABLE "Product" ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("title",'')), 'A') ||
    setweight(to_tsvector('english', coalesce("description",'')), 'B')
  ) STORED;
CREATE INDEX "Product_searchVector_idx" ON "Product" USING GIN ("searchVector");
```

This **passes `pnpm db:check-migrations`** by construction — the guard only inspects
`ALTER TABLE … ADD COLUMN … NOT NULL` without `DEFAULT`, explicitly exempts `GENERATED`
(`check-migration-sql.ts:84`), and never inspects `CREATE INDEX` (`:60`). Lean toward also
declaring `searchVector Unsupported("tsvector")?` in `schema.prisma` (self-documenting)
with the discipline of reviewing any future auto-migration touching `Product`.

**Repository** `productRepository.searchActiveByTenant({ tenantId, query, page, pageSize })`:
one `$queryRaw` for ranked ids (`WHERE "tenantId"=${tenantId} AND status='ACTIVE' AND
"searchVector" @@ websearch_to_tsquery('english', ${query}) ORDER BY ts_rank(...) DESC,
"createdAt" DESC LIMIT/OFFSET`), one `$queryRaw` for `count(*)::int`, batched in a
`$transaction` like `listByTenant`; then a typed `findMany({ where:{ id:{ in: rankedIds }},
include:{ variants:true }})` to hydrate rows, **re-ordered in JS** (a `Map`, since `IN`
doesn't preserve order) so `available = stock - reserved` renders through the same
`<ProductCard>`/`availableUnits()` path as `/products`. Match tenant+ACTIVE only (don't
additionally hide out-of-stock — `/products` badges them, `product-card.tsx:34,44-48`).
Offset pagination is the repo convention (no cursor precedent).

**UI**: `(storefront)/search/page.tsx` (`force-dynamic`, `searchParams` parsed with a
forgiving `z.coerce`/`.catch()` schema like `listOrdersParamsSchema`,
`validators/orders.ts:54-57`), a plain `<form action="/search" method="GET">` with
`<input name="q">` in the header nav (no client JS), results in the existing `ProductCard`
grid, distinct empty-query vs zero-results states.

**Raw-SQL safety (non-negotiable)**: `Prisma.$queryRaw` **tagged template only** (repo
convention — `membership.repository.ts:87,118` is the SELECT precedent); bind `${query}`
as a parameter to `websearch_to_tsquery` (which also never throws on malformed operator
input — important for a user-typed box). Cast counts `::int` (else Postgres `BigInt` breaks
JSON).

### D. Analytics — time-series + net-revenue (#93)

**Day-bucketing needs raw SQL** — Prisma `groupBy` can't truncate dates (confirmed against
6.19.3; matches the existing comment `analytics.repository.ts:47-51`). `Order` carries
`tenantId` natively, so the query is simpler than the repo's Product-relation-scoped raw
UPDATEs:

```sql
SELECT date_trunc('day', "createdAt") AS "day",
  COUNT(*)::int AS "totalOrders",
  COALESCE(SUM("totalCents") FILTER (WHERE status IN ('PAID','FULFILLED','REFUNDED')),0)::int AS "grossCents",
  COALESCE(SUM("totalCents") FILTER (WHERE status = 'REFUNDED'),0)::int AS "refundedCents"
FROM "Order" WHERE "tenantId" = ${tenantId} AND "createdAt" >= ${since}
GROUP BY 1 ORDER BY 1
```

`since` is computed by the **service** (a new `ANALYTICS_WINDOW_DAYS` constant); the
service **zero-fills** every missing day via a `Map` (identical to `ordersByStatus`'s
backfill, `analytics.service.ts:70-76`). Double-quote every camelCase alias (unquoted
folds to lowercase in Postgres → `undefined` on the typed row).

**#93 fix** = **rename** `DashboardSummary.revenueCents → netRevenueCents` (the misleading
_label_ is the complaint) and expose gross / refunds / net: add
`refundedTotalCents(tenantId)` (a one-line sibling of `revenueTotalCents`, `status:
"REFUNDED"`); **don't touch** `revenueTotalCents` (PAID+FULFILLED is correct and already
integration-tested — it _is_ net); `gross = net + refunded`. `REFUNDED` is reached only
from PAID/FULFILLED via one webhook-driven transition (`order.repository.ts:650-661`), so
`PAID+FULFILLED+REFUNDED` is exactly "everything that ever captured payment," and
`CANCELLED` correctly never counts.

**Buckets are UTC days, deterministic** — `Order.createdAt` is naive `TIMESTAMP(3)`
(`migrations/…_init/migration.sql:15`); Postgres `date_trunc` on a naive timestamp is
session-TZ-independent (PG16 docs), Prisma writes UTC, and dev/CI containers default UTC
(no `TZ` in `docker-compose.yml` or `ci.yml`). Caption charts "by day, UTC". **Refunds
attribute to the order's `createdAt`** (same bucket as the sale) — one `GROUP BY`,
self-consistent net; documented caveat: refunding an old order lowers that past day's net
on next render (a `refundedAt DateTime?` column is the clean future fix, not needed now).

**Charts = hand-rolled inline SVG, not Recharts.** Recharts on React 19 needs a
`react-is` peer-dep override (this repo exact-pins `react@19.2.8`), is ~50KB, client-only,
and pops in on measure — wrong for a pure server read. Inline SVG in a Server Component:
`viewBox` + `w-full` (fluid, no JS), `vector-effect="non-scaling-stroke"`, colours from the
**already-present but unused** `--chart-1..5`/`--primary` tokens (`globals.css:23-27,
54-115`) via Tailwind classes (`stroke-primary`, `fill-chart-2`) — theme-aware for free, no
`oklchToSrgb`. A11y: `<figure>` + `aria-label`/`<figcaption>` + an `sr-only <table>`
fallback. Two small charts (revenue line/area + order-count bars), **not** dual-axis. The
points→path math is a pure helper (`src/lib/…`), unit-tested incl. the all-zero edge (guard
the `maxValue` denominator against `NaN`).

**Placement**: a compact chart on `/admin/[storeSlug]` after the KPI row (relabel the KPI
"Net revenue" + a "View full analytics" link — same idiom as the existing "View all
orders" link, `admin/page.tsx:183-189`), plus a dedicated `/admin/[storeSlug]/analytics`
page with full charts + a visible daily `<Table>`. Nav link visible to STAFF+ (read-only
reporting, not OWNER-gated). No new index — `@@index([tenantId, createdAt])`
(`schema.prisma:220`) already serves the equality-then-range query.

---

## Risks & unknowns (consolidated)

| Area          | Risk                                                                   | Mitigation                                                                                                                                                                    |
| ------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-store   | **Client-forgeable `x-tenant-slug`**                                   | Proxy **deletes inbound** `x-tenant-slug` before setting the trusted value (Vercel mandate). Hard requirement.                                                                |
| Multi-store   | Cross-subdomain session widens blast radius                            | Model A: auth/admin on apex, cookies host-scoped; `crossSubDomainCookies` stays **off**.                                                                                      |
| Multi-store   | `*.localhost` dev-asset 403s under `next dev`                          | `allowedDevOrigins: ["*.localhost"]` in `next.config.ts` (dev-only; prod/Playwright unaffected).                                                                              |
| Multi-store   | Unknown-subdomain must be a **real** 404, not a soft-200               | `notFound()` is at the storefront **layout** (not inside a page `<Suspense>`), so it's fine — but re-verify on `pnpm build && pnpm start`, per the project's soft-404 gotcha. |
| Multi-store   | Bad hue → CSS injection in server-rendered `<style>`                   | Validate `z.number().int().min(0).max(359)` before interpolation (an int can't break out).                                                                                    |
| Multi-store   | Wildcard-domain hosting is an infra prereq                             | Document as an operator step; dev works via `*.localhost`. Confirm a real domain before promising deployed subdomains.                                                        |
| Accounts      | Server-action `signUpEmail`/`signInEmail` clobbers the caller's cookie | Keep sign-up/in **client-driven**; checkout only `getSession` (read-only).                                                                                                    |
| Accounts      | `/sign-in` redirect hard-allowlisted to `/admin`                       | Broaden to `/account`-prefixed, or fork a storefront sign-in surface. Required code change, not "just works".                                                                 |
| Accounts      | #92 fix could regress guest reuse (#25) or leak across identities      | Guest branch requires `userId: null` in WHERE (not just omitting the filter).                                                                                                 |
| Search        | SQL injection via the search box                                       | `$queryRaw` tagged template only; `websearch_to_tsquery('english', ${query})` bound param.                                                                                    |
| Search        | `count(*)` → JS `BigInt`; `IN (...)` doesn't preserve order            | `count(*)::int`; re-order hydrated rows via a `Map`.                                                                                                                          |
| Search        | Future auto-migration proposes dropping the generated column           | Author via `--create-only`; review any future migration touching `Product`; don't accept a spurious DROP.                                                                     |
| Analytics     | Refund attribution to `createdAt` mutates past buckets                 | Documented caveat + chart caption; `refundedAt DateTime?` is the future clean fix.                                                                                            |
| Analytics     | Unquoted camelCase SQL aliases silently lowercase                      | Double-quote every alias; cast aggregates `::int`.                                                                                                                            |
| Cross-cutting | New admin pages live under `[storeSlug]`                               | All admin work (theme editor, analytics page, switcher) lands **after** the path-scoped admin refactor.                                                                       |

## Recommended approach (build sequence → issues)

Ordered smallest-risk-first, dependencies noted. This maps 1:1 to the GitHub issues.

**Foundation**

1. **Subdomain tenant resolution** — proxy host-parse + inbound-strip + trusted
   `x-tenant-slug`; `getStoreTenant()` reads it (dev/test fallback: bare
   `localhost`→`demo`); reserved-word `Set`; `allowedDevOrigins`; tenant `/`→`/products`.
   Derive the bare domain from the existing `NEXT_PUBLIC_APP_URL` (no new required env).
   _Foundation for the whole storefront._
2. **Path-scoped admin `/admin/[storeSlug]` + tenant-aware `requireAdminContext`** —
   move the admin subtree; authorize membership in the URL's store; update proxy matcher +
   admin E2E. _Foundation for all admin work._

**Multi-store features** 3. **Per-tenant theming** — `Tenant.themeHue Int @default(162)` migration; thread through
`StoreContext`; scoped `<style>` in the storefront layout; validate/fallback. _(needs 1)_ 4. **Self-serve onboarding** — `tenant.errors.ts`; `tenantRepository.createWithOwner`
(txn, P2002→`SlugTakenError`); slug zod schema; `/new` page + Server Action; apex
landing CTA. _(needs 1 for the reserved `Set`)_ 5. **Store switcher + `/admin` index** — list the user's stores, switch between them.
_(needs 2)_ 6. **OWNER-only theme/branding editor** — `settingsService.updateStoreTheme` mirroring
`updateStoreCurrency`; admin settings UI. _(needs 2, 3)_

**Authenticated shoppers** 7. **`Order.userId` + record at checkout** — migration (nullable FK + index);
shopper-session read helper; thread `userId` into order creation. _(independent)_ 8. **Storefront shopper auth surface** — storefront sign-in/up (allowlist fix or fork);
nav "Sign in"/"My orders". _(independent)_ 9. **Authenticated checkout + close #92** — read session in checkout; bind reuse to
`userId`; guest branch `userId:null`. _(needs 7, 8)_ · **Issue #92** 10. **Order history** — `/account/orders` list + `[id]` detail;
`listByTenantAndUser` + `findByIdForTenantAndUser`. _(needs 7, 8)_

**Discovery + analytics** 11. **Search index + repository** — `product_search_vector` migration (`--create-only`);
`searchActiveByTenant` raw query + hydrate + re-order. _(independent)_ 12. **Storefront search UI** — `/search` page + nav search box. _(needs 11)_ 13. **Analytics net-revenue** — `refundedTotalCents`; rename → `netRevenueCents`; gross /
refunds / net on the dashboard. _(independent)_ · **Issue #93** 14. **Time-series + SVG charts** — `revenueTimeSeries` raw query + zero-fill; SVG
`trend-chart` + path helper (unit-tested); compact chart on `/admin/[storeSlug]` +
dedicated `/admin/[storeSlug]/analytics`. _(needs 2, 13)_

**Verification** 15. **E2E for a new critical flow** — Playwright for authenticated checkout (or
onboarding). _(needs the relevant features)_

Tests are written **with** each issue (unit for pure logic/services, integration for the
new raw queries), per the three-tier split — not retrofitted.

## References

- Next 16 installed docs: `proxy.md`, `functions/headers.md`, `functions/next-response.md`,
  `guides/authentication.md`, `guides/caching-without-cache-components.md`,
  `config/.../allowedDevOrigins.md`, `config/.../rewrites.md`.
- Better Auth 1.7.2 installed source: `dist/integrations/next-js.mjs`,
  `dist/cookies/index.mjs`, `dist/context/helpers.mjs`, `@better-auth/core` `init-options.ts`.
  Docs: better-auth.com/docs/concepts/cookies.
- Vercel multi-tenant: docs/platforms/multi-tenant-platforms/{concepts,middleware-and-routing,quickstart}.
- Prisma 6 FTS status + drift: prisma.io/docs/orm/prisma-client/queries/full-text-search;
  prisma/prisma#15654, #24496, #14786, #27186. `groupBy` date limit: discussions #24169, #11692.
- Postgres 16 `date_trunc` (naive-timestamp TZ independence): postgresql.org/docs/16/functions-datetime.html.
- shadcn chart (wraps Recharts, `"use client"`): ui.shadcn.com/docs/components/chart;
  Recharts React 19 `react-is` override: recharts #4558, #5461.
- In-repo ground truth: `src/proxy.ts`, `src/server/store-context.ts`,
  `src/server/auth/{index,admin-context,client}.ts`,
  `src/server/repositories/{tenant,membership,user,order,product,analytics}.repository.ts`,
  `src/server/services/{order,analytics,settings}.service.ts`, `src/lib/{color,inventory,env}.ts`,
  `src/lib/validators/{catalog,orders}.ts`, `src/app/globals.css`, `src/app/(storefront)/**`,
  `src/app/(admin)/admin/**`, `src/app/(auth)/**`, `prisma/schema.prisma`,
  `scripts/lib/check-migration-sql.ts`, `docs/{ARCHITECTURE,DATABASE,DESIGN}.md`,
  `docs/milestones/M2-production-grade/{research,handoff}.md`.
