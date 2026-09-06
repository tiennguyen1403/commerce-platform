# Handoff — M2 Production-grade

> Written at milestone close (by the `scribe` agent).

Hardens the M1 commerce slice into something production-grade: a three-tier automated
test suite in CI, real observability, reliable (retried) email delivery, inventory held
at checkout, surfaced RBAC, and an order lifecycle that goes beyond PAID — fulfil,
cancel, and Stripe-webhook-driven refunds.

## Shipped

- **Email config optional at boot** (#39, PR #61) — `src/lib/env.ts:13-44`
  (`RESEND_API_KEY`/`EMAIL_FROM` → `optionalEnvString`, blank-or-absent both collapse to
  `undefined`); validated at send time instead (`email.service.ts:244-252` throws
  `EmailNotConfiguredError`). A missing/blank Resend config no longer takes down
  checkout at boot — only the best-effort email is skipped.
- **Static migration-safety guard** (#38, PR #62) — `scripts/check-migrations.ts` +
  `scripts/lib/check-migration-sql.ts` (`findUnsafeColumnAdds`), wired into CI as
  `pnpm db:check-migrations` (`.github/workflows/ci.yml:34-36`). Scans migration SQL
  only (no DB, no Prisma engine) for a `NOT NULL` column added with no `DEFAULT`; the
  pre-existing `account_issuer` migration is grandfathered by name
  (`check-migrations.ts:23`) with its corrective path documented in `docs/DATABASE.md`.
- **Vitest harness + unit/service tests** (#46, #47, PR #63, PR #64) —
  `vitest.config.mts` (three `test.projects` — `unit`/`dom`/`integration`, split by
  filename); `vitest.setup.ts` (dummy env, mirrors `ci.yml`); `vitest.server-only-shim.ts`
  (aliases `server-only` to a no-op so Vitest can import server-only modules). 26
  unit/dom test files now cover pure logic (`cart.ts`, `color.ts`, `roles.ts`,
  `proxy.ts`, zod validators) and every service against mocked repositories
  (`order.service.test.ts` alone is 1,149 lines).
- **Repository integration tests + `test-db` CI job** (#41, #48, PR #65) — 4
  `*.integration.test.ts` files against a real Postgres: `order.repository.integration.test.ts`
  (1,499 lines — concurrent double-delivery at `:426`, a reservation race at `:597`,
  double-cancel at `:820`, double-fulfil at `:961`, double-refund at `:1113`),
  `product.repository.integration.test.ts`, `outbox.repository.integration.test.ts`,
  `analytics.repository.integration.test.ts`; `src/test/integration-db.ts`
  (throwaway-tenant isolation, FK-safe cleanup). New `test-db` job (`ci.yml:48-93`) runs
  `pnpm test:integration` (`vitest run --project integration --no-file-parallelism`)
  against a `postgres:16-alpine` service, in parallel with `verify`. Folds in #41's fix:
  `product.repository.ts`'s `updateWithVariants` transaction now takes the same
  explicit `{ timeout: 15_000 }` as the order path.
- **Structured logging + error-reporting seam** (#51, PR #66) —
  `src/server/observability/logger.ts` (a bare `pino()`, no transport —
  `pino.transport()`'s worker thread crashes under Turbopack, `vercel/next.js#84766`);
  `src/server/observability/error-reporter.ts` (`reportError`, Sentry-
  `captureException`-shaped, never throws, optional `ERROR_WEBHOOK_URL` POST to
  Slack/Discord); wired at `src/instrumentation.ts`'s `onRequestError` for unhandled
  RSC/route/Server-Action/proxy errors, and called directly at catch sites that already
  swallow (the webhook, member/settings/order actions).
- **Health readiness/liveness rework** (#52, PR #67) —
  `src/server/repositories/health.repository.ts` (`ping()` — the one repository with no
  tenant scope) + `src/server/services/health.service.ts`; `GET /api/health` now calls
  the service instead of Prisma directly (200/503 on DB up/down, `cache-control:
no-store`); new `GET /api/health/live` never touches the DB, so a transient DB blip
  can't trigger an orchestrator restart loop.
- **Cron harness** (#53, PR #68) — `src/server/cron/verify-cron-request.ts` (Bearer
  token, SHA-256-hashed constant-time compare, fails closed when `CRON_SECRET` is
  unset/blank); `.github/workflows/cron.yml` (GitHub Actions `schedule:` every 10
  minutes, the frequent primary trigger); `vercel.json` (Vercel Cron as the durable
  backstop, since GH Actions auto-disables scheduled workflows after 60 days of repo
  inactivity).
- **Transactional email outbox** (#30, PR #69) — `OutboxMessage` model (migration
  `20260901092549_outbox_messages`); enqueued inside `markPaidByPaymentIntent`'s
  PENDING → PAID transaction (`order.repository.ts:402-409`); drained by
  `src/server/services/outbox.service.ts` (claim → send → settle, exponential backoff,
  `MAX_SEND_ATTEMPTS = 10` ≈ 8.5h of retries) via `GET /api/cron/dispatch-outbox`. The
  webhook's `dispatchForOrder` call (`route.ts:87`) is now a latency optimization, not
  the delivery mechanism — delivery is at-least-once, not at-most-once.
- **RBAC enforcement + OWNER-only members page** (#55, PR #70) —
  `requireRole`/`assertRole` (`src/server/auth/admin-context.ts:72-89`);
  `src/app/(admin)/admin/members/**` (add an existing user by email, change role,
  remove); last-owner protection via a `SELECT … FOR UPDATE` on the tenant's OWNER rows
  inside one transaction (`membership.repository.ts:87,118`); role-aware nav hides
  Members/Settings from non-owners (`admin/layout.tsx:18,48-63`) — UX only, every
  action re-checks server-side.
- **OWNER-only store currency settings** (#35, PR #71) —
  `src/app/(admin)/admin/settings/**`, `src/server/services/settings.service.ts`; gated
  with `requireRole(ROLES.OWNER)` on the page and `assertRole(ROLES.OWNER)` on the
  action; revalidates every route that shows a price and warns that existing prices
  aren't converted.
- **Inventory reservation** (#54, PR #73) — `ProductVariant.reserved` (migration
  `20260901115000_variant_reserved`); reserved atomically at checkout via a
  parameterized `$executeRaw` guard (`order.repository.ts:201-211`, `stock - reserved
  > = qty`); released via the shared `releaseReserved` helper (`:126-145`, floored at
0); reconciled at PAID right after the stock decrement (`:457-464`).
`available = stock - reserved` (`src/lib/inventory.ts`) is now what the storefront
reads and clamps to; backorder is blocked (0 rows reserved → `InsufficientStockError`).
- **`server-only` across the db → repository → service layer, and `auth/index`** (#72,
  #75, PR #74, PR #76) — defense-in-depth `import "server-only"` added to every
  repository, every service, `db.ts`, and `auth/index.ts` (27 files total, verified by
  grep) — none of it can reach a client bundle even by accident.
- **Order lifecycle: cancel + fulfil + the `oversold` flag** (#56, #40, PR #77) —
  `orderRepository.cancelPendingAndRelease` / `markFulfilled`
  (`order.repository.ts:550-626`), each an atomic status-guarded `updateMany`;
  `Order.oversold` (migration `20260901130303_order_oversold_flag_and_list_index`) set
  inside the same PAID transaction as a shortfall (`:447-455`) — feeds the distinct
  oversold email copy landed in PR #80 (`email.service.ts`'s
  `renderOrderConfirmation`, `:143-165`) and the orders-list warning badge.
- **Stripe refunds + refund webhook** (#57, PR #79) — `orderService.refundOrder`
  (ADMIN+, makes **no** DB write — `order.service.ts:803-838`);
  `orderRepository.markRefundedByPaymentIntent` (`:650-671`, PAID|FULFILLED →
  REFUNDED); the webhook handles `refund.created`/`refund.updated`/`refund.failed`,
  branching on `refund.status`, not the event name (`route.ts:122-220`) — the webhook
  remains the sole writer of `REFUNDED`.
- **Admin orders list + detail UI** (#58, PR #80) —
  `src/app/(admin)/admin/orders/**` (paginated, status-filterable list; detail page
  with role-gated cancel/fulfil/refund buttons in `order-actions.tsx`); a same-PR
  fix (commit `b6809d0`, folded in) corrected a `formatDate` bug (`timeZoneName`
  combined with `dateStyle`/`timeStyle`) that 404'd the detail page.
- **Dedupe in-flight PaymentIntents + sweep abandoned PENDING orders** (#25, PR #82) —
  `tryReuseInFlightIntent` (`order.service.ts:265-320`) reuses a still-awaiting
  PaymentIntent for a re-submitted cart instead of minting a second one;
  `sweepAbandonedPending` (`:879-912`) cancels a 30-minutes-stale PENDING order's
  intent and releases its hold only once the intent is provably `canceled`
  (`disposeChargeableIntent`, `:379-419`); the cron entry point is
  `GET /api/cron/sweep-orders`.
- **Cancel the Stripe PaymentIntent when an admin cancels a PENDING order** (#81, PR
  #83) — `orderService.cancelOrder` (`:732-767`) now retires the intent first via the
  shared `disposeChargeableIntent`, refusing the cancel with a typed
  `OrderTransitionError` if payment is in flight — closes the money-unsafe gap where
  the DB could flip an order CANCELLED while Stripe still held a chargeable intent
  underneath it.
- **Lean analytics dashboard** (#59, PR #84) —
  `src/server/repositories/analytics.repository.ts` + `analytics.service.ts`; `/admin`
  shows revenue (PAID + FULFILLED only — see Known issues re: #93), order counts by
  status (zero-filled), low-stock variants (via `availableUnits`), recent orders — no
  Prisma in the page.
- **Playwright harness + admin auth-gate E2E** (#49, PR #85) — `playwright.config.ts`
  (boots `pnpm start`, a real production build, never `next dev`; single worker;
  chromium only); `e2e/admin-auth.spec.ts` (proxy redirect to
  `/sign-in?redirect=%2Fadmin`, sign-in, sign-out re-gates it).
- **`db:seed` runs under the react-server condition** (#86, PR #87) —
  `package.json:26` (`"prisma": { "seed": "node --conditions=react-server --import tsx
prisma/seed.ts" }`) — `pnpm db:seed` now works without a manual flag, since the seed
  script transitively imports `server-only`-guarded modules.
- **Full checkout → PAID E2E + `e2e` CI job** (#50, PR #88) —
  `e2e/checkout.spec.ts` + `e2e/support/stripe.ts` (hand-signs
  `payment_intent.succeeded` with `Stripe.webhooks.generateTestHeaderString`) drives
  the real Payment Element in a browser, then asserts PENDING → PAID + `stock`/
  `reserved` movement via a direct Prisma read; new `e2e` job (`ci.yml:100-167`,
  `needs: verify`) supplies real Stripe test-mode secrets at the job `env:` level, so
  `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is present at `pnpm build` (Next inlines it
  then, not at `next start`).
- **Stripe Payment Element dark-mode/theme** (#27, PR #89) — `src/lib/color.ts`
  (`oklchToSrgb`, Björn Ottosson's OKLab pipeline) +
  `src/app/(storefront)/checkout/checkout-appearance.ts` — resolves the app's OKLCH
  design tokens to hex/rgba at the iframe boundary, since Stripe's Appearance API
  can't read `oklch()` or CSS custom properties from a cross-origin document.
- **Bound the Resend send with a timeout** (#31, PR #90) — `email.service.ts:58-86`
  (`SEND_TIMEOUT_MS = 5_000`, `withSendTimeout` via `Promise.race`, since Resend's SDK
  exposes no native timeout/AbortSignal hook) — a hung Resend call can no longer hold
  the webhook's response path open toward Stripe's own delivery timeout.
- **Stripe webhook route branch test hardening** (#78, PR #91) —
  `src/app/api/webhooks/stripe/route.test.ts` (530 lines) covering signature failure,
  both event families, every outcome branch (paid/already-processed/no-order; refund
  succeeded/failed/interim/no-payment-intent), and the handler-error 500 path.

## Exit criteria

All nine checklist items in `GOAL.md` — the source of truth transcribed verbatim below
(the task brief that seeded this handoff said "8"; the file itself has nine).

- [x] **Tests run green in CI** — Vitest unit + service tests, repository integration
      tests on a real Postgres service (incl. a concurrent double-delivery test
      asserting exactly one PAID transition), and Playwright E2E for the admin auth
      gate and the full checkout → PAID flow — #46/#47 (PR #63, #64), #41/#48 (PR
      #65), #49 (PR #85), #50 (PR #88); the double-delivery test is
      `order.repository.integration.test.ts:426`. CI green on `development` @
      `c10f48c`: jobs `verify` + `test-db` + `e2e` all `success` (GitHub Actions run
      33596147689).
- [x] **Order lifecycle beyond PAID** — an admin views orders (list + detail, PR
      #80/#58), marks a PAID order FULFILLED and cancels a PENDING order (PR
      #77/#56), and issues a refund (PR #79/#57); `REFUNDED` is driven only by the
      Stripe refund webhook (`route.ts:182-220`), never the client
      (`orderService.refundOrder` makes no DB write, `order.service.ts:791`). Every
      transition is an atomic status-guarded `updateMany`, idempotent
      (integration-tested under concurrent double-transitions — see the four tests
      cited under Shipped), and tenant-scoped.
- [x] **Inventory reserved at PENDING** and released on cancel/sweep; backorder
      blocked; oversell at PAID still detected and surfaced (#40); abandoned PENDING
      orders swept (#25) — PR #73 (#54) reserves/releases/reconciles
      (`order.repository.ts:126-145,201-211,457-464`); PR #77 (#56) adds the durable
      `Order.oversold` flag (`:447-455`); PR #80 (#58) adds the oversold-specific
      email copy and list badge, closing #40; PR #82 (#25) sweeps stale PENDING
      orders (`order.service.ts:879-912`).
- [x] **RBAC enforced and surfaced** — server-side role gates on every privileged
      action (`assertRole` in every member/settings/order Server Action), role-aware
      admin nav (`admin/layout.tsx:48-63`), OWNER-only member management with
      last-owner protection (`membership.repository.ts:81-138`) and currency
      settings (#35) — PR #70 (#55), PR #71 (#35).
- [x] **Observability** — structured logging replaces ad-hoc `console.*`
      (`src/server/observability/logger.ts`); an error-reporting seam
      (`error-reporter.ts` + `instrumentation.ts`'s `onRequestError`) captures
      unhandled server errors; `/api/health` is a real readiness check via
      `healthRepository.ping()`, not direct Prisma, with a separate
      `/api/health/live` liveness endpoint — PR #66 (#51), PR #67 (#52).
- [x] **Reliable email** — order-confirmation email goes through the
      `OutboxMessage` table with retry/backoff, drained by
      `GET /api/cron/dispatch-outbox` (PR #69/#30); missing email config no longer
      crashes boot (PR #61/#39, `env.ts:36-37`); the webhook makes no blocking email
      call — it enqueues in-transaction and fires a timeout-bounded best-effort
      dispatch only (PR #90/#31, `email.service.ts:58`).
- [x] **Lean analytics** at `/admin` — revenue, counts-by-status, low-stock, recent
      orders, all tenant-scoped, with no Prisma in the page
      (`analytics.repository.ts` + `analytics.service.ts` + `admin/page.tsx`) — PR
      #84/#59.
- [x] **Carried-over M2 fixes closed** — #25 (PR #82), #27 (PR #89), #30 (PR #69),
      #31 (PR #90), #35 (PR #71), #38 (PR #62), #39 (PR #61), #40 (PR #77 + PR
      #80), #41 (PR #65).
- [x] `pnpm build`, `pnpm typecheck`, `pnpm lint`, and the full test suite green;
      CI passing on `development` — CI green on `development` @ `c10f48c`: jobs
      `verify` + `test-db` + `e2e` all `success` (GitHub Actions run 33596147689).

## Key decisions

Also appended to the `docs/ARCHITECTURE.md` §9 decision log.

- **Transactional email outbox, not a direct send from the webhook** — the PENDING →
  PAID transaction only enqueues an `OutboxMessage` (`order.repository.ts:402-409`); a
  scheduled drain does the actual send with retry/backoff. This is what genuinely
  fixes #31 (no network call left on the webhook's response path) and #30 (a Resend
  outage no longer drops the email forever) — turning delivery from at-most-once into
  at-least-once. The webhook's own `dispatchForOrder` call is now a non-blocking,
  timeout-bounded latency optimization, never the delivery guarantee.
- **Inventory reservation supersedes M1's decrement-at-capture** — stock is held
  (`ProductVariant.reserved`) at PENDING via an atomic `$executeRaw` guard (Prisma's
  query builder can't compare two columns of the same row), released on cancel/sweep,
  and reconciled at PAID. `available = stock - reserved` is now the one sellable-units
  figure the storefront and analytics read; backorder is blocked. Oversell at PAID
  remains possible (an admin can cut `stock` below the reserved count in the payment
  window) and is still surfaced, not blocked — reservation makes it rare, not
  impossible.
- **Order state machine completed, with a strict split of writer authority** — PAID →
  FULFILLED is a manual status attestation only (no fulfilment provider or shipping
  address until M4); PENDING → CANCELLED retires the Stripe PaymentIntent _first_ and
  only flips the DB once the intent is provably `canceled`
  (`disposeChargeableIntent`, shared by the sweep and the admin cancel); PAID|FULFILLED
  → REFUNDED is driven exclusively by the Stripe refund webhook — the admin "Refund"
  action only calls Stripe, it never writes the DB.
- **RBAC surfaced with `requireRole` (pages, redirects) / `assertRole` (Server
  Actions, throws)** — server-side defense-in-depth on top of role-aware nav (nav
  hiding is UX only). `OWNER > ADMIN > STAFF`; last-owner demotion/removal is guarded
  by a `SELECT … FOR UPDATE` on the tenant's OWNER rows inside one transaction, closing
  a TOCTOU that a plain count-then-check would leave open.
- **No Sentry; a thin `reportError` seam instead** — `@sentry/nextjs` 10.38+ crashes
  in production under Next 16 + Turbopack (`getsentry/sentry-javascript#19367`, closed
  "not planned"); `src/server/observability/error-reporter.ts` is a swappable,
  Sentry-`captureException`-shaped stand-in (structured log + optional chat-webhook
  fan-out) wired at `instrumentation.ts`'s `onRequestError`. Logging is a bare
  `pino()` with no transport — `pino.transport()`'s worker thread crashes under
  Turbopack (`vercel/next.js#84766`).
- **Background/periodic work: GitHub Actions `schedule:` (primary) + Vercel Cron
  (backstop), both hitting secret-protected `GET /api/cron/*`** — Vercel Hobby cron is
  capped at once/day (too coarse for the outbox drain or the abandoned-order sweep);
  GH Actions runs every 10 minutes but auto-disables after 60 days of repo inactivity,
  which Vercel Cron covers. `CRON_SECRET` is read straight from `process.env`,
  deliberately outside `env.ts`'s strict schema, so an unset secret 401s the cron
  routes (fail-closed) rather than blocking boot.
- **Money-safety primitive shared by the sweep and the admin cancel** —
  `disposeChargeableIntent` (`order.service.ts:379-419`) is the one place that decides
  whether a PENDING order's PaymentIntent can be safely retired; an order is only ever
  flipped CANCELLED once its intent is provably `canceled`, so the DB and Stripe's
  captured-money state can never diverge.
- **Three-tier Vitest split by filename, not by folder** — `*.test.ts` (unit, mocked
  repos, zero infra), `*.test.tsx` (dom), `*.integration.test.ts` (real Postgres,
  serial, throwaway-tenant isolation). `server-only` is aliased to a no-op only inside
  the test runner (`vitest.server-only-shim.ts`), never in the real build.
- **`server-only` applied blanket-wide across the db → repository → service layer and
  `auth/index`** — defense-in-depth so a refactor can never accidentally pull server
  internals into a client bundle; enforced by convention/review, not tooling.

## Known issues / tech debt

Two independent review passes ran at handoff: the built-in `security-review` skill
over the whole `main...development` diff found **no vulnerabilities**; the `reviewer`
agent found the milestone **ship-ready**, with no BLOCKER/HIGH/MEDIUM findings. Two
low-severity follow-ups were filed rather than blocking the release:

- `#92` — LOW, security hardening. Guest-checkout's PaymentIntent reuse
  (`tryReuseInFlightIntent`, `order.service.ts:265-320`) matches a re-submitted cart to
  a prior PENDING order by **tenant + client-supplied email**, with no proof the same
  shopper is resubmitting — a narrow, low-impact exploit (at most, someone who knows a
  victim's email and cart contents could observe or interfere with an in-flight
  PaymentIntent). Closes naturally once M3 ships authenticated checkout, which binds
  reuse to an account rather than an email string. [M3]
- `#93` — NIT, analytics. `analyticsRepository.revenueTotalCents` sums only
  `PAID`/`FULFILLED` orders (`analytics.repository.ts:39-45`), so a `REFUNDED` order
  (which was `PAID`) drops out of revenue **wholesale** instead of being netted or
  labeled as "held" revenue — understates activity rather than overstating it, so it's
  a reporting gap, not a correctness bug. [M3]

One further review nit was raised and closed with **no action**: `member-role-select.tsx`
sets state during render (`:46-49`) to re-sync the select's value when the server's
role changes under it. This is React's own sanctioned "adjust state on prop change"
pattern — guarded by `if (role !== syncedRole)`, never an unconditional set — not a bug.

Operational notes for whoever deploys this:

- The scheduled cron (`.github/workflows/cron.yml`) is a **silent no-op** until an
  operator sets both the `CRON_TARGET_URL` repo **variable** and the `CRON_SECRET` repo
  **secret** — until then the workflow "succeeds" on every run without ever calling
  the app (deliberate, so an unconfigured fork never shows a red workflow). Vercel Cron
  (`vercel.json`) needs the same `CRON_SECRET` set on the deployment.
- Branch protection on `development`/`main` requires the `verify` **and** `test-db`
  checks (both must be green to merge; 0 required reviews, `enforce_admins=false`). The
  `e2e` job runs on every PR but is deliberately **not** a required check — it stays
  advisory so its longer, browser-driven run never hard-blocks a merge.
- The seeded default admin (`prisma/seed.ts`) still falls back to
  `SEED_ADMIN_EMAIL=admin@demo.test` / `SEED_ADMIN_PASSWORD=changeit-dev-only` when
  unset (carried from M1) — override `SEED_ADMIN_*` before seeding any shared/staging
  database.

Carried from M1, now closed: `#38`, `#39`, `#40`, `#41` — see Exit criteria above.
Still open, deferred to M3 by design (not regressions): catalog search, a full
analytics dashboard/time-series, subdomains/theming/onboarding, Stripe Connect,
authenticated checkout, email invitations, partial refunds + auto-restock — see
[`docs/milestones/M3-platform/GOAL.md`](../M3-platform/GOAL.md).

## How to run & verify

```bash
docker compose up -d                 # Postgres on host port 55432
pnpm install
cp .env.example .env                 # then fill in the values below
pnpm db:migrate
pnpm db:seed                         # demo tenant, 5 products, seeded admin
pnpm dev                             # http://localhost:3000
```

Beyond M1's setup, M2 changes what's required in `.env`:

- `RESEND_API_KEY` / `EMAIL_FROM` are now **optional** (#39) — leave both blank and the
  app still boots and checkout still completes; the confirmation email is queued, then
  dies permanently (`EmailNotConfiguredError`) the first time the outbox drain tries
  it. Set both to actually receive the email.
- `CRON_SECRET` — generate one (`openssl rand -hex 32`) to exercise
  `/api/cron/dispatch-outbox` and `/api/cron/sweep-orders` by hand; leave it blank
  locally and both routes just 401 (fail-closed, never blocks boot elsewhere).
- `ERROR_WEBHOOK_URL` — optional, a Slack/Discord incoming webhook for `reportError`'s
  fan-out; leave unset to just log.

Run the test suites:

```bash
pnpm test                            # unit + dom — no infra, seconds
pnpm db:check-migrations             # static migration-safety guard, no DB needed
pnpm test:integration                # needs `docker compose up -d` (Postgres on 55432)

pnpm build && pnpm test:e2e          # Playwright boots `pnpm start` itself
```

For a checkout E2E that actually drives Stripe locally, export real test-mode keys
before `pnpm build` (`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is inlined at build time, not
at `pnpm start`): `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, and any
string for `STRIPE_WEBHOOK_SECRET` (the spec hand-signs its own webhook, so it never
has to match a real Stripe-registered secret).

Forward real Stripe webhooks for manual click-through (unchanged from M1):

```bash
stripe login
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

**Happy path** — M1's base flow (browse → cart → checkout → PAID → confirmation email,
see `docs/milestones/M1-commerce-slice/handoff.md`) is unchanged and still the place to
start. On top of it, M2 adds:

1. Open a fresh checkout tab and start payment but don't submit it; in a second tab,
   sign in and open `/admin/orders` — the order is PENDING. Cancel it. Confirm it
   flips to CANCELLED and the reserved unit returns to `available` on the product's PDP.
2. Complete a real checkout (M1 steps), then on `/admin/orders/<id>` click
   **Mark fulfilled** — confirm FULFILLED.
3. On another PAID order, sign in as an ADMIN or OWNER and click **Refund** — confirm
   the order stays PAID until the refund webhook lands (forward it via
   `stripe listen`, or `stripe trigger charge.refunded`-style test), then flips to
   REFUNDED.
4. Visit `/admin` — revenue, order counts, low-stock, and recent orders render with no
   console/Prisma errors.
5. Visit `/admin/members` (OWNER only) — add a second seeded user by email, change
   their role, remove them; confirm you can't demote/remove yourself or the tenant's
   last OWNER.
6. Visit `/admin/settings` (OWNER only) — change the store currency; confirm the
   storefront and admin product prices relabel.
7. `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/dispatch-outbox`
   — drains any queued confirmation email; the same call with no header (or a wrong
   one) 401s.
8. `GET /api/health` (200, `{"db":"up", ...}`) and `GET /api/health/live` (always 200,
   no DB) both respond directly.

A concurrent double-submit is a safe no-op throughout: re-clicking "Continue to
payment" on the same cart reuses the in-flight PaymentIntent rather than minting a
second order (#25); a duplicate refund/cancel/fulfil webhook or click transitions the
order at most once (see the four concurrency tests under Shipped).

## Inherited by next milestone

M3 can assume:

- A three-tier test pyramid (unit/service, real-Postgres integration, Playwright E2E)
  wired into CI (`verify`, `test-db`, `e2e` jobs) — new M3 features land with tests
  from day one, not retrofitted at a later hardening milestone.
- The observability stack (`logger`, `reportError`, `/api/health` + `/api/health/live`)
  — M3 can plug real alerting (a Slack/Discord `ERROR_WEBHOOK_URL`) with zero code
  changes.
- The outbox pattern generalizes to any future async message type
  (`OutboxMessageType` has one value today, `ORDER_CONFIRMATION`) — a new async
  side-effect is a new enum case + a `sendMessage` branch, not a new subsystem.
- The cron harness (`verifyCronRequest` + the GH-Actions/Vercel dual scheduler) is a
  generic secret-protected background-job seam — a new scheduled task is a new
  `/api/cron/*` route plus one line in `cron.yml` and `vercel.json`.
- Inventory reservation and `available = stock - reserved` are the sellable-units
  source of truth everywhere — any M3 browse/search UI must read `available`, never
  `stock` alone.
- The order lifecycle is feature-complete except real fulfilment: PENDING → PAID →
  FULFILLED, CANCELLED, and REFUNDED are all live, atomic, idempotent, and
  webhook/action-driven.
- RBAC (`requireRole`/`assertRole`, `OWNER > ADMIN > STAFF`) is the established pattern
  for every future privileged surface, including whatever subdomain/theming/onboarding
  work M3 adds.
- Two flagged, non-blocking follow-ups for M3 to pick up deliberately: #92 (harden the
  guest-checkout identity binding — closes by construction once checkout is
  authenticated) and #93 (net or label `REFUNDED` revenue in analytics).

Seams left open on purpose (tracked, not blocking):

- **"Mark fulfilled" is a manual attestation, not real fulfilment** — there is no
  shipping address anywhere in the schema/checkout, and
  `src/server/fulfillment/printful.ts` still throws "not implemented". Real
  fulfilment + address collection is M4.
- **Guest checkout only** — no customer accounts, no order history for a shopper; see
  #92 above (M3).
- **Refunds are full-only** — no partial refunds, no automatic restock on a refund
  (goodwill vs. return is ambiguous; left to the manual product-edit form). M3
  candidate.
- **No catalog search, no time-series/chart analytics** — explicitly deferred at M2's
  own milestone start in favor of depth over breadth. M3.
- **Single store, single currency, no subdomains, no Stripe Connect** — M3.
- **No email invitations for non-existing users** — the members page is
  add-existing-user-only, per the session-hijack finding in
  `docs/milestones/M2-production-grade/research.md` (calling Better Auth's
  `signUpEmail` from an admin action would overwrite the OWNER's session cookie).
  Optional M3 fast-follow.

## Links

- Release: **`vM2`** — pending (release PR `development` → `main` + tag not yet cut).
- Milestone: GitHub Milestone "M2 — production-grade" (#2) — 28/28 issues closed.
- Review: `security-review` over the full `main...development` diff — no
  vulnerabilities found. `reviewer` agent structural pass — ship-ready, no
  BLOCKER/HIGH/MEDIUM findings.
- Merged PRs: #45 (docs: M2 seed), #60 (docs: M2 research+GOAL), #61 (closes #39),
  #62 (closes #38), #63 (closes #46), #64 (closes #47), #65 (closes #41, #48),
  #66 (closes #51), #67 (closes #52), #68 (closes #53), #69 (closes #30),
  #70 (closes #55), #71 (closes #35), #73 (closes #54), #74 (closes #72),
  #76 (closes #75), #77 (closes #56), #79 (closes #57), #80 (closes #58),
  #82 (closes #25), #83 (closes #81), #84 (closes #59), #85 (closes #49),
  #87 (closes #86), #88 (closes #50), #89 (closes #27), #90 (closes #31),
  #91 (closes #78).
- Closed issues: #25, #27, #30, #31, #35, #38, #39, #40, #41, #46, #47, #48, #49, #50,
  #51, #52, #53, #54, #55, #56, #57, #58, #59, #72, #75, #78, #81, #86.
- Changeset: `main...development` — 60 commits, 125 files, +15,393 / −327
  (`git diff main...development --stat`).
- Follow-ups filed at handoff: #92, #93.
