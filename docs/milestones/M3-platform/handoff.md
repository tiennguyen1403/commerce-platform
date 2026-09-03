# Handoff — M3 Platform

> Written at milestone close (by the `scribe` agent).

Turns the single-store, production-grade app from M2 into a real multi-tenant
**platform**: every store lives on its own subdomain and can be self-served by anyone
who signs up; shoppers get accounts, authenticated checkout, and an order history; the
catalog is searchable; and the admin gets time-series analytics with refunds correctly
netted out of revenue.

## Shipped

- **Subdomain tenant resolution — "Model A"** (#96, PR #110) — `src/proxy.ts`,
  `src/server/store-context.ts`, `src/lib/tenant-host.ts`, `src/config/constants.ts`.
  The proxy strips any inbound `x-tenant-slug` header, resolves `{slug}.{app-domain}`
  from the request `Host` (`resolveTenantSlug`, `tenant-host.ts:31-62`), and injects the
  trusted, host-derived value (`proxy.ts:43-67`); `getStoreTenant()`
  (`store-context.ts:33-46`) is its sole reader and 404s on an unknown slug. A
  bare-loopback host (`localhost`/`127.0.0.1`) falls back to the seeded `demo` tenant
  only while `NEXT_PUBLIC_APP_URL` itself points at localhost (dev + Playwright), never
  in a real deployment (`tenant-host.ts:41-48`). Reserved words (`www`, `admin`, `api`,
  …) never resolve to a store (`RESERVED_SUBDOMAINS`, `constants.ts:32-43`).
- **Path-scoped admin `/admin/[storeSlug]`** (#97, PR #111) —
  `src/server/auth/admin-context.ts`, `src/app/(admin)/admin/[storeSlug]/**`.
  `requireAdminContext(storeSlug)` (`admin-context.ts:46-78`) re-derives the session and
  checks the caller's membership against the store named on the URL — not a hard-coded
  tenant — so one user can administer several stores; an unknown store and a store the
  caller isn't a member of are both a 404, indistinguishable from each other.
  `requireRole`/`assertRole` now take `storeSlug` as their first argument.
- **Self-serve store onboarding** (#99, PR #112) — `src/app/new/**`,
  `src/server/services/tenant.service.ts`, `src/server/repositories/tenant.repository.ts`,
  `src/server/tenant.errors.ts`, `src/lib/validators/tenant.ts`. A signed-in visitor
  picks a name + subdomain at `/new`; the Server Action (`new/actions.ts:58-84`)
  re-derives the session server-side (never trusts a client-supplied owner id), the
  service validates length/shape/reserved-word rules (`tenant.service.ts:37-55`), and the
  repository creates the `Tenant` and its first `OWNER` `Membership` in one transaction
  (`tenant.repository.ts:35-55`), with a `P2002` → `SlugTakenError` race backstop behind
  the friendly pre-check.
- **Per-tenant storefront theming** (#98, PR #114) — `Tenant.themeHue`,
  `src/lib/theme.ts`, `src/app/(storefront)/layout.tsx`. Each store carries one OKLCH
  hue (`themeHueSchema`, `theme.ts:62`, validated 0–359 with a safe default fallback);
  `tenantThemeCss(hue)` (`theme.ts:122-133`) re-parametrizes five accent tokens for both
  light and dark, and the storefront layout SSR-injects it scoped to
  `[data-tenant-theme]` (`(storefront)/layout.tsx:44-45`) — never `:root` — so the
  sibling `(admin)`/`(auth)` trees are untouched. The seed now provisions a second store
  (`aurora`, violet hue 285°), storefront-only, so the accent is visible side by side
  with `demo` locally (`prisma/seed.ts`). **Portal-overlay follow-up** (#113, PR #117):
  a body-portaled overlay (e.g. `SelectContent`) escapes the wrapper's CSS scope and
  fell back to the platform default accent; `TENANT_THEME_PORTAL_ATTR` — a marker any
  storefront overlay portaled to `<body>` must stamp (`select.tsx:93`) — gets the same
  recipe re-emitted for it.
- **Store switcher + `/admin` index** (#100, PR #115) — bare `/admin`
  (`admin/page.tsx`) lists the caller's own memberships and redirects straight through
  when there's exactly one; `StoreSwitcher` (`[storeSlug]/store-switcher.tsx`) renders
  real links (not a value picker, so middle-click still opens a new tab) to jump between
  stores from inside the admin nav.
- **OWNER branding editor** (#101, PR #116) — `settings/store-name-form.tsx`,
  `settings/theme-form.tsx`. OWNER-gated (`assertRole(storeSlug, ROLES.OWNER)`) forms to
  rename the store and pick an accent hue, with a live preview
  (`accentPreview`, `theme.ts:156-172`) rendered outside the themed subtree.
- **Order↔shopper link** (#102, PR #118) — `Order.userId` (nullable FK, `onDelete:
SetNull`), migration `20260902190258_order_user_link` (also adds the
  `[tenantId, userId, createdAt]` index). Checkout stamps `userId` from the
  server-derived session (`checkout/actions.ts:40-41`), never from the client; a guest
  order keeps `userId: null`.
- **Shopper sign-in/up surface** (#103, PR #119) — `src/app/(storefront)/account/**`,
  `src/server/auth/shopper-context.ts`. Storefront-scoped sign-in/up pages and an
  `AccountMenu` nav entry, driven client-side by Better Auth's `authClient` — never a
  Server Action that could touch the admin's session cookie. `getShopperSession()`
  (`shopper-context.ts:29-39`) mirrors `requireAdminContext`'s caching but the opposite
  posture: it never redirects and never throws, since a guest is the storefront's normal
  visitor.
- **#92 identity binding** (PR #120) — `order.service.ts:273-294`
  (`tryReuseInFlightIntent`), `order.repository.ts:365-384`
  (`findReusablePendingCandidates`). In-flight PaymentIntent reuse now discriminates on
  `userId`: a signed-in shopper matches on the session-proven `userId`; a guest stays
  email-keyed but is pinned to `userId: null` in the same query, so a guest-supplied
  email can no longer match a signed-in shopper's PENDING order.
- **Shopper order history** (#104, PR #121) — `order.repository.ts:604-620`
  (`listByTenantAndUser`), `:312-317` (`findByIdForTenantAndUser`), `/account/orders`.
  Both scoped by **both** `tenantId` and the session-proven `userId`, served by the same
  `[tenantId, userId, createdAt]` index; a foreign or guest order resolves to a real
  404, never another shopper's data.
- **Catalog search** (#105, PR #122) — `product.repository.ts:91-145`
  (`searchActiveByTenant`), migration `20260903032216_product_search_vector` (a
  `GENERATED … STORED` `tsvector` column + GIN index, since Prisma can't express one —
  `schema.prisma` declares it `Unsupported("tsvector")` only so `migrate` sees it and
  never proposes to drop it). Tenant + `ACTIVE`-only, ranked via
  `websearch_to_tsquery`/`ts_rank`, every value bound through a tagged-template
  `$queryRaw`, offset-paginated; ids are hydrated via a second tenant-scoped `findMany`
  re-ordered in JS. **Search UI** (#106, PR #123) — `/search`, reusing the storefront's
  own `ProductCard` so results reflect `available = stock - reserved` exactly like
  `/products`.
- **Analytics: gross / refunds / net** (#93, PR #124) — `analytics.repository.ts:76-90`
  (`revenueBreakdown`). `grossCents` now sums every captured order (PAID + FULFILLED +
  REFUNDED); `netCents = grossCents − refundedCents` — a refund is netted out of revenue
  instead of dropping its order from the total wholesale.
- **Analytics time-series + inline SVG charts** (#107, PR #125) —
  `analytics.repository.ts:117-140` (`revenueTimeSeries`, one `$queryRaw` bucketing by
  UTC day), `analytics.service.ts:152-176` (`getRevenueTimeSeries`, zero-fills the
  trailing 30-day window), `src/lib/chart.ts` (pure point/path/bar geometry, unit
  tested), `src/components/charts/trend-chart.tsx` (server components, no client JS,
  theme-token colors, `aria-hidden` SVG + `sr-only` data table),
  `/admin/[storeSlug]/analytics` — no Prisma import in the page.
- **Onboarding E2E** (#108, PR #126) — `e2e/onboarding.spec.ts`. Drives sign-up →
  create-store → lands as OWNER on `/admin/<slug>` against the real production build;
  asserts both the admin chrome (UI) and the tenant/membership row (DB); a unique
  email/slug per run plus an `afterAll` cleanup keep it deterministic.
- **Security fix found and closed at handoff**: open-redirect via dot-segment
  normalization (#127, PR #128) — `src/lib/safe-redirect.ts:28-34`. Found by the
  milestone's own security review: `safeInternalPath` checked the origin of the
  _parsed_ redirect target but returned the _normalized_ path, and a leading dot-segment
  (`/..//evil.com`) normalizes into a protocol-relative pathname the origin check never
  saw. The guard now re-resolves the exact value it's about to return, the same way the
  router will, and rejects it if that no longer lands on the placeholder origin.
  Regression tests cover all four dot-segment/encoded probe forms
  (`safe-redirect.test.ts:43-54`).

## Exit criteria

All thirteen checklist items in `GOAL.md` — the source of truth, condensed below with
evidence.

- [x] **Subdomain routing** — `<store>.<app-domain>` renders that store's catalog; an
      unknown subdomain 404s; reserved subdomains are refused as stores; the storefront
      no longer references `DEMO_TENANT_SLUG` directly (it survives only as the
      constant's own definition, `constants.ts:14`, and the bare-loopback dev fallback,
      `tenant-host.ts:41-48` — verified by grep across `src/`, 3 total hits, none
      outside those two files). Local-dev subdomain recipe documented in `README.md`'s
      "Local subdomains" section — PR #110 (#96): `proxy.ts:43-67`,
      `tenant-host.ts:31-62`, `store-context.ts:33-46`.
- [x] **Onboarding** — a signed-in user self-serves a new store and becomes its OWNER in
      one transaction; slug validation + reserved words + collision handling enforced
      server-side (a friendly pre-check plus a `P2002` race backstop); a user can own
      more than one store (the bare `/admin` index lists every membership) — PR #112
      (#99): `tenant.repository.ts:35-55`, `tenant.service.ts:37-55`,
      `validators/tenant.ts:34-50`, `new/actions.ts:58-84`; integration-tested
      atomically, including the P2002 backstop
      (`tenant.repository.integration.test.ts:49,71`).
- [x] **Tenant-aware admin** — path-scoped `/admin/[storeSlug]` with a store switcher;
      `requireAdminContext(storeSlug)` authorizes membership in the store on the URL (a
      non-member is refused with a 404); no admin file references `DEMO_TENANT_SLUG`
      (verified by grep) — PR #111 (#97): `admin-context.ts:46-78`; PR #115 (#100):
      `[storeSlug]/store-switcher.tsx`.
- [x] **Theming** — each store shows its own accent via SSR CSS variables, theme-aware
      (light/dark), no cross-tenant bleed (scoped to `[data-tenant-theme]`, never
      `:root`); an invalid stored hue falls back to the default without breaking the
      page (`resolveThemeHue`) — PR #114 (#98): `theme.ts:62,122-133`,
      `(storefront)/layout.tsx:44-45`; portal-overlay bleed closed by PR #117 (#113).
- [x] **Shopper accounts** — a shopper signs up/signs in on the storefront
      (`account/sign-in`, `account/sign-up`, client-driven `authClient`) without
      touching the admin's session cookie; checkout completes while authenticated
      (`userId` threaded into `orderService.startCheckout`) — PR #119 (#103);
      `checkout/actions.ts:40-51`.
- [x] **Order history** — a signed-in shopper sees only their own orders for that store,
      scoped by **both** `userId` and `tenantId`; guest checkout still works end to end
      (`userId` stays `null`) — PR #121 (#104): `order.repository.ts:604-620,312-317`;
      integration-tested (`order.repository.integration.test.ts:1664,1785`).
- [x] **#92 closed** — authenticated checkout binds PaymentIntent reuse to the
      session-proven account, never a client-supplied email — PR #120:
      `order.service.ts:273-294`, `order.repository.ts:365-384`; integration-tested
      (`order.repository.integration.test.ts:1417`).
- [x] **Search** — tenant + `ACTIVE`-only, reflects `available`, parameterized
      (tagged-template `$queryRaw`, never `$queryRawUnsafe`), paginated — PR #122
      (#105): `product.repository.ts:91-145`; integration-tested
      (`product.repository.integration.test.ts:298`); UI at `/search` — PR #123 (#106).
- [x] **Analytics time-series** — revenue + order-count over time on
      `/admin/[storeSlug]/analytics`, tenant-scoped, no Prisma in the page, accessible
      (labelled `<figure>`s, an `sr-only` data table, explicit `scope` on headers) and
      theme-aware (chart colors are theme tokens) — PR #125 (#107):
      `analytics.repository.ts:117-140`, `analytics.service.ts:152-176`,
      `trend-chart.tsx`; integration-tested
      (`analytics.repository.integration.test.ts:225`).
- [x] **#93 closed** — revenue reported as gross / refunds / net; a `REFUNDED` order is
      netted, never silently dropped — PR #124 (#93): `analytics.repository.ts:76-90`.
- [x] **Tests green in CI** — new unit/service coverage (`chart.test.ts`,
      `safe-redirect.test.ts`, `tenant-host.test.ts`, `theme.test.ts`,
      `validators/tenant.test.ts`, `tenant.service.test.ts`,
      `membership.service.test.ts`, extended `analytics.service.test.ts` and
      `order.service.test.ts`, extended `proxy.test.ts`; a new DOM test,
      `account/account-menu.test.tsx`), repository integration tests for every new raw
      query and write path (search, time-series, the onboarding transaction, the
      identity-bound reuse query, order-history scoping — see citations above), and the
      onboarding Playwright E2E (#108, PR #126) — `verify` + `test-db` + `e2e` all green
      on `development` @ `c966fb1` (GitHub Actions run 33732218765).
- [x] **Quality gates** — `pnpm build`, `pnpm typecheck`, `pnpm lint`, and the full test
      suite green; CI passing on `development` — same run as above.
- [x] **Docs** — `research.md` + `GOAL.md` (produced at `/milestone-start`, PR #109),
      the `docs/ARCHITECTURE.md` decision log (this handoff), `handoff.md` (this file).
      `docs/DATABASE.md` needed no changes this milestone: all three M3 migrations
      already fit its documented conventions — `themeHue`/`Order.userId` are
      `NOT NULL DEFAULT …` / nullable (both already-safe, already-documented forms),
      and the `searchVector` `GENERATED` column is exempted by the guard's existing
      identity/serial/`GENERATED` carve-out (`check-migration-sql.ts:84`) since it
      isn't `NOT NULL` to begin with.

## Key decisions

Also appended to the `docs/ARCHITECTURE.md` §8 decision log.

- **Subdomain tenant resolution — "Model A"** — the tenant is resolved from the request
  `Host` in the proxy, which strips any inbound `x-tenant-slug` before injecting the
  trusted, host-derived one (anti-spoof; also a Vercel-recommended pattern for
  proxy-injected headers). `getStoreTenant()` is the sole reader. Auth, admin, and
  onboarding stay centralized on the **apex** host so cookies remain host-scoped
  (`crossSubDomainCookies` off) — a store subdomain carries no session authority of its
  own. A bare-loopback → `demo` fallback, keyed on `NEXT_PUBLIC_APP_URL` being
  localhost, keeps local dev and Playwright working without provisioning real
  subdomains; it's off in any real deployment.
- **Path-scoped admin `/admin/[storeSlug]` + `requireAdminContext(storeSlug)`** — a
  user may own many stores, so authorization re-checks membership against the store
  named on the URL rather than trusting a session-pinned tenant. A non-member and an
  unknown store are both a 404, indistinguishable — the admin never leaks which stores
  exist. Bookmarkable, no hidden session state to go stale.
- **Per-tenant theming via SSR-injected, scoped `<style>`** — `Tenant.themeHue` (an
  `Int`, validated 0–359 with a safe fallback) is scoped to `[data-tenant-theme]` (plus
  a portal marker for body-portaled overlays), rendered with native `oklch()`, and
  theme-aware (light/dark). Scoping to a wrapper attribute rather than `:root` is what
  keeps a store's accent from bleeding into the sibling `(admin)`/`(auth)` trees.
- **Shoppers reuse the global `User` model** — a shopper is a `User` with no
  `Membership`, authenticated by the same single Better Auth instance the admin uses.
  Trade-off: email is unique platform-wide, so one email can't hold separate shopper
  accounts at two different stores — documented rather than engineered around, since
  splitting identity per tenant would complicate auth for comparatively little value at
  this scale. `Order.userId` is a nullable FK (`SetNull`); orders stay tenant-scoped
  regardless of whether the account is later deleted.
- **#92 identity binding** — in-flight PaymentIntent reuse now binds to the
  session-proven `userId`; the guest branch requires `userId: null` in the `WHERE`
  (a discriminated union on the query, not just the service), so a guest-supplied email
  can no longer match a signed-in shopper's PENDING order. Closes #92 without
  regressing guest reuse (#25, from M2).
- **Catalog search = raw-SQL `tsvector` + GIN**, not Prisma's preview Postgres
  full-text-search API — a `GENERATED … STORED` column (Postgres maintains it on every
  write) plus a GIN index, queried with `websearch_to_tsquery` through a parameterized
  tagged-template `$queryRaw` (never `$queryRawUnsafe`). Ranked ids are hydrated via a
  second, tenant-scoped `findMany` and re-ordered in JS, since `IN (…)` doesn't
  preserve order. Reads `available = stock - reserved`, the same sellable-units figure
  as the rest of the storefront.
- **Analytics: raw-SQL `date_trunc` day-buckets (UTC), zero-filled in the service; #93's
  net-revenue model** — `grossCents` sums every captured order status (PAID +
  FULFILLED + REFUNDED), `netCents = gross − refunded`, so a refund is netted rather
  than making its order vanish from revenue wholesale. Charts are **hand-rolled inline
  SVG** (server-rendered, zero client JS, theme-token colors, `sr-only` table
  fallback), not a charting library — Recharts needs a React 19 `react-is` override, is
  client-only, and pulls ~50KB for two small charts.
- **The `?redirect=` open-redirect guard validates the value it _returns_, not just the
  parsed input** — normalization can turn an on-origin parse into a protocol-relative
  _result_ (`"/..//evil.com"` → pathname `"//evil.com"`), so a prefix/origin check on
  the input alone is insufficient. The guard now re-resolves the exact value it's about
  to hand back the way the router will, and rejects it if that no longer lands on the
  placeholder origin. Found by the milestone's own security review and fixed inside
  the same milestone (#127, PR #128).

## Known issues / tech debt

Two independent review passes ran at handoff. The `reviewer` agent's structural pass
found the milestone ship-ready — no BLOCKER/HIGH/MEDIUM findings, every exit criterion
met — but raised three low-severity follow-ups (below). The built-in `security-review`
skill found **one MEDIUM**: the `safeInternalPath` open-redirect bypass (#127, CWE-601,
confidence 9/10) — found and **fixed inside this milestone** (PR #128), verified
empirically with regression tests covering all four dot-segment/encoded probe forms, so
`vM3` ships with it already closed rather than carried forward.

Three non-blocking follow-ups were filed rather than blocking the release:

- `#129` — LOW, UX/correctness. The apex landing's "Shop the store" → `/products` link
  404s on a real (non-localhost) apex host, since the proxy injects no tenant slug there
  and `getStoreTenant()` calls `notFound()`; it only appears to work locally via the
  loopback→`demo` fallback. The page's "Phase 0 · foundations live" badge
  (`src/app/page.tsx:22`) is also stale, left over from M0. Not a security/data issue —
  no live custom domain is configured yet.
- `#130` — LOW, analytics. `analyticsRepository.revenueTimeSeries`'s window bound
  (`"createdAt" >= ${since}`) compares a JS `Date` against a `timestamp without time
zone` column; under a non-UTC Postgres session timezone, the oldest boundary day
  could shift by the offset. Bucketing itself is TZ-independent (`date_trunc`/`to_char`
  on the naive column, zero-filled by UTC day key in the service), and dev/CI default
  to UTC, so no figure is wrong today — a reporting-precision gap, not a live bug.
- `#131` — NIT, defense-in-depth. `/admin` is reachable per-host on a store subdomain
  (e.g. `store.example.com/admin/...`), not only the apex. **Not exploitable** —
  `requireAdminContext(storeSlug)` re-checks membership regardless of host, and cookies
  stay host-scoped (Model A) — but it slightly widens the surface versus the
  "auth/admin on the apex only" design intent. Optional: a proxy guard that bounces
  `/admin` (and `/new`, `/api/auth`) on a tenant host back to the apex.

Operational notes (mostly carried from M2, still accurate):

- The seeded default admin (`prisma/seed.ts`) still falls back to
  `SEED_ADMIN_EMAIL=admin@demo.test` / `SEED_ADMIN_PASSWORD=changeit-dev-only` when
  unset — override `SEED_ADMIN_*` before seeding any shared/staging database. The seed
  now also provisions a second, storefront-only store (`aurora`, violet hue 285°) to
  demo per-tenant theming side by side with `demo`; it deliberately has no members,
  since the admin-auth E2E assumes the seeded admin owns exactly one store (see
  `docs/milestones/M3-platform/research.md`).
- The scheduled cron (`.github/workflows/cron.yml`) and Vercel Cron (`vercel.json`) are
  unchanged from M2 — both stay a silent no-op until `CRON_TARGET_URL`/`CRON_SECRET`
  are set.
- Branch protection on `development`/`main` still requires only the `verify` and
  `test-db` checks (0 required reviews, `enforce_admins=false`); `e2e` remains
  advisory, not required.
- **New in M3**: deployed (non-localhost) subdomains need wildcard-domain hosting — a
  `*.{domain}` project entry plus Vercel-managed nameservers — an **operator
  infrastructure prerequisite**, not something the app provisions itself (see
  `docs/milestones/M3-platform/research.md`). Local dev needs none of this:
  `*.localhost` resolves to loopback automatically, and `next.config.ts`'s
  `allowedDevOrigins: ["*.localhost"]` lets Turbopack serve HMR/dev assets across those
  subdomains.

## How to run & verify

```bash
docker compose up -d                 # Postgres on host port 55432
pnpm install
cp .env.example .env                 # then fill in the values below
pnpm db:migrate
pnpm db:seed                         # demo + aurora tenants, products, seeded admin
pnpm dev                             # http://localhost:3000
```

`.env` is unchanged from M2 — no new required variables. `NEXT_PUBLIC_APP_URL`
(already required) is what M3's subdomain fallback keys off: leave it pointed at
`localhost` for local dev.

Local per-tenant subdomains (from `README.md`'s "Local subdomains" section — modern
browsers resolve `*.localhost` to loopback automatically, no `/etc/hosts` edits):

| URL                     | Resolves to                                  |
| ----------------------- | -------------------------------------------- |
| `demo.localhost:3000`   | the seeded **demo** store (emerald accent)   |
| `aurora.localhost:3000` | the seeded **aurora** store (violet accent)  |
| `localhost:3000`        | also the demo store (bare-loopback fallback) |
| `acme.localhost:3000`   | an unknown tenant → a real **404**           |
| `www.localhost:3000`    | the platform/apex landing (a reserved word)  |

A store host's `/` redirects to `/products`.

```bash
pnpm test                            # unit + dom — no infra, seconds
pnpm db:check-migrations             # static migration-safety guard, no DB needed
pnpm test:integration                # needs `docker compose up -d` (Postgres on 55432)

pnpm build && pnpm test:e2e          # Playwright boots `pnpm start` itself
```

**Happy path** — M1/M2's base flow (browse → cart → checkout → PAID, admin order
lifecycle) is unchanged; see their handoffs. On top of it, M3 adds:

1. Visit `demo.localhost:3000` and `aurora.localhost:3000` side by side — same code,
   different accent (emerald vs. violet), different catalog. Visit
   `weird.localhost:3000` — a real 404.
2. Sign up at `demo.localhost:3000/sign-up?redirect=/new`, then create a store at `/new`
   with a fresh subdomain — land on `/admin/<your-slug>` as its OWNER. Visit
   `<your-slug>.localhost:3000` — your new (default-themed) storefront.
3. From `/admin` (bare), confirm the store switcher/picker appears once you own 2+
   stores; jump between them.
4. As OWNER, open `/admin/<slug>/settings` — rename the store and change its accent;
   confirm the storefront picks up both.
5. On the storefront, sign in/up at `/account/sign-in` (separate from admin auth); add
   something to cart and check out — the resulting order appears at `/account/orders`.
   Sign out and check out as a guest — still works, and appears in no one's history.
6. Use the search box in the storefront header (or `/search`) — results are this
   store's `ACTIVE` products only, ranked by relevance, respecting stock.
7. Visit `/admin/<slug>/analytics` — revenue/order-count charts render for the last 30
   days, with an `sr-only` data table underneath (tab through it or use a screen reader
   to confirm).
8. Refund a PAID order (M2 flow), then revisit `/admin` and the analytics page — the
   refunded amount is now shown as netted out of revenue, not vanished from the total.

## Inherited by next milestone

M4 (fulfillment) can assume:

- A real multi-store platform: subdomain routing, self-serve onboarding, per-tenant
  theming, and a store switcher are all live — any new admin surface should follow the
  `/admin/[storeSlug]` + `requireAdminContext(storeSlug)` pattern established here.
- Authenticated shoppers with an `Order.userId` link and an order-history page — M4 can
  attach a shipping address to the shopper/order without inventing an identity model.
- Tenant-scoped catalog search and time-series analytics, both raw-SQL-backed and
  integration-tested — the pattern (parameterized `$queryRaw`, no Prisma in the page)
  is reusable for any future reporting surface.
- The three-tier test pyramid + CI wiring from M2 continues to cover every new surface
  from day one (see the new test files under Exit criteria above).

Seams left open on purpose, unchanged from M2's list except where noted:

- **"Mark fulfilled" is still a manual attestation, not real fulfilment** — there is
  still no shipping address anywhere in the schema/checkout, and
  `src/server/fulfillment/printful.ts` still throws "not implemented". This is M4's
  core.
- **Refunds are still full-only** — no partial refunds, no automatic restock.
- **Single platform Stripe account, no Stripe Connect** — deferred again; a per-tenant
  payout model reshapes the payment layer enough to deserve its own milestone.
- **Email is unique platform-wide** — one email can't hold separate shopper accounts at
  two different stores (the documented trade-off of reusing the global `User` model for
  shoppers — see the decision log).
- **No email invitations for non-existing users** — still add-existing-user-only, per
  the M2 session-hijack finding.
- Three low-severity follow-ups deliberately deferred rather than fixed in M3: #129
  (apex landing), #130 (analytics TZ-sensitive window bound), #131 (optional
  admin-on-tenant-subdomain proxy guard) — see Known issues above.

## Links

- Release: **`vM3`** — pending (release PR `development` → `main` + tag cut at
  handoff).
- Milestone: GitHub Milestone "M3 — platform" (#3) — 18/18 closed, 0 open.
- Review: `reviewer` agent structural pass — ship-ready, no BLOCKER/HIGH/MEDIUM
  findings, three LOW/NIT follow-ups filed (#129, #130, #131). Built-in
  `security-review` skill — one MEDIUM found (#127, CWE-601) and fixed in-milestone
  (PR #128).
- Merged PRs: #109 (docs: M3 seed), #110 (closes #96), #111 (closes #97), #112 (closes
  #99), #114 (closes #98), #115 (closes #100), #116 (closes #101), #117 (closes #113),
  #118 (closes #102), #119 (closes #103), #120 (closes #92), #121 (closes #104),
  #122 (closes #105), #123 (closes #106), #124 (closes #93), #125 (closes #107),
  #126 (closes #108), #128 (closes #127).
- Closed issues: #92, #93, #96, #97, #98, #99, #100, #101, #102, #103, #104, #105,
  #106, #107, #108, #113, #127.
- Changeset: `vM2..development` — 38 commits, 112 files, +7,767 / −730
  (`git diff vM2..development --shortstat`).
- Follow-ups filed at handoff: #129, #130, #131.
