# Research — M2 Production-grade

> Produced at milestone start (2026-09-01) by three parallel `researcher` passes
> (Testing & CI · Observability & background work · Commerce hardening). Read before
> building. Evidence-first: every claim below was verified against the **installed**
> versions (`node_modules`/`package.json`) or a fresh docs/web lookup, with `path:line`
> citations. Where docs and code disagreed, the code won.

## Context & goal

Harden the M1 commerce slice into something production-grade. Scope was set to a
**focused hardening** milestone (see [`GOAL.md`](GOAL.md)): tests, observability,
reliability/outbox, inventory reservation, RBAC surfacing, order lifecycle + refunds, and
a lean analytics view — plus the nine carried-over M1 fixes. **Deferred to M3:** catalog
search and a full analytics dashboard.

Installed stack verified: `next@16.3.3` (Turbopack default for dev **and** build),
`react@19.2.8`, `typescript@5`, `prisma`/`@prisma/client@6.19.3`, `better-auth@1.7.2`,
`stripe@22.6.0`, `@stripe/react-stripe-js@6.8.2`, `resend@6.25.0`, `zod@4.5.4`,
`pnpm@11.24.0`. **No test tooling installed.**

## Key questions

1. How do we test a Next 16 / server-only / Prisma codebase — what's the pyramid, and how
   do we drive Stripe checkout + the webhook deterministically in CI?
2. What's the right observability stack when Sentry is broken on Next 16 + Turbopack, and
   **how do we run periodic/background work at all** (needed by the outbox and the sweep)?
3. How do we surface RBAC, expand the order state machine (fulfil/cancel/refund), and add
   inventory reservation without breaking M1's atomic/idempotent guarantees?

---

## Findings — Testing & CI

**Current state.** No test tooling installed (`package.json:23-55`). `ci.yml` has one job
(`verify`): install → `prisma generate` → lint → typecheck → build. No Postgres service,
no `migrate deploy`, no seed, no test step. The DB-less build works only because every
DB-reading page uses `export const dynamic = "force-dynamic"`, so `next build` never
queries Postgres — a deliberate M1 decision (`M1/research.md:100`) that M2 must close.

**Central Vitest gotchas (verified in source):**

- **`server-only` throws under Vitest.** The package resolves to its throwing `index.js`
  unless the bundler sets the `"react-server"` export condition; Vitest never does. Five
  hot-path files import it (`src/lib/env.ts:1`, `src/server/cart-cookie.ts:1`,
  `src/lib/stripe.ts:1`, `src/server/services/email.service.ts:1`,
  `src/server/auth/admin-context.ts:1`). **Fix:** alias `server-only` → an empty module in
  `vitest.config.ts`'s `resolve.alias`. Repositories are unaffected (they import only
  `@prisma/client`/`@/server/db`/local errors) — importable unshimmed.
- **`next/headers` `cookies()` throws** outside a live request
  (`next/dist/server/request/cookies.js:132`). `readCart`/`writeCart`/`clearCart`
  (`cart-cookie.ts:26-70`) need `vi.mock("next/headers")` with a fake jar.
- **`env.ts` is all-required** (`z.string().min(1)`, parsed at import, `env.ts:28-33`).
  A `setupFiles` entry must set the 8 dummy vars via `??=` before `@/lib/env` first loads
  (mirror `ci.yml`'s existing dummy block exactly).
- **Async Server Components aren't Vitest-testable** — Next's own guide says use E2E for
  them (`docs/.../testing/vitest.md:9`). Every page here is an async RSC → page coverage
  goes entirely to Playwright; Vitest/RTL is for pure logic + services + small sync client
  leaves only.

**The crown jewel needs a real Postgres.** `order.repository.markPaidByPaymentIntent`
(`order.repository.ts:149-239`) is one `$transaction` doing (1) a status-guarded
`updateMany({status:PENDING}→PAID)` as the sole idempotency point (`:177-180`), (2) a
stock-guarded `updateMany({stock:{gte:qty}})` per line, ordered by `variantId` for
deadlock safety (`:162-166`), (3) oversell shortfall collection (`:189-230`). This is
Postgres row-locking + `updateMany` count semantics under test — meaningless against a
mock. It needs an integration test on real Postgres, including a `Promise.all` concurrent
double-delivery asserting exactly one transition. Second tier: `updateWithVariants`
(`product.repository.ts:129-238`, the two-phase SKU swap + `VariantInUseError`/P2003).
**Isolation trick:** every table is `tenantId`-scoped, so each test creates its own
throwaway `Tenant` (random slug) — no truncation between tests.

**Stripe webhook in tests — hand-sign, don't `stripe listen`.** `constructEvent`
(`stripe@22.6.0 Webhooks.js:17-32`) just verifies the HMAC over the raw string and
`JSON.parse`s — no deep schema validation — and the route only reads `event.type`,
`metadata.tenantId`, `paymentIntent.id` (`route.ts:65,73`). So a minimal hand-crafted
`payment_intent.succeeded` body drives the real path, signed with the SDK's **static**
`Stripe.webhooks.generateTestHeaderString({payload,secret})` (`Webhooks.d.ts:63-74`,
`stripe.core.js:131` — no API key needed to sign). This beats `stripe listen` (needs the
CLI, live egress, nondeterministic 1-5s lag) and a test-only bypass route (extra prod
surface). Note the SDK uses `NodeHttpClient` not `fetch`, so Next's `testmode` fetch-mock
can't fake Stripe — and the Payment Element talks to Stripe from the **browser** anyway,
so real test-mode keys are unavoidable for a true checkout E2E.

**Payment Element iframe (Playwright):** `page.frameLocator('iframe[name^="__privateStripeFrame"]')`
(prefix match — Stripe rotates the name), fill by role/label. Card `4242 4242 4242 4242`.

**Next 16 / Turbopack CI traps (verified vs installed docs):**

- `NEXT_PUBLIC_*` is inlined at **`next build`** time, not `next start`
  (`docs/.../environment-variables.md:158,164,198`) → in the E2E job the **real**
  `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` must be present at the `pnpm build` step (set it at
  the **job** `env:` level), else `loadStripe(… ?? "")` bakes in `""` and the Element never
  mounts.
- E2E runs against `next build` + `next start`, never `next dev` (Turbopack dev is the
  flaky one; Playwright's own guide agrees).

**Versions (checked live):** vitest 4.1.11 (use `test.projects`, not
`vitest.workspace.ts`), @vitejs/plugin-react 6.1.1, vite-tsconfig-paths 6.1.1,
@testing-library/react 16.3.3, @playwright/test 1.62.1. Reuse the installed `stripe` for
signing (no new dep). Playwright browsers: install fresh (`--with-deps`); official
guidance shows no cache step.

### Recommended pyramid

1. **Pure logic (node, zero infra):** `cart.ts` reducers, `formatMoney`/`slugify`,
   `hasAtLeast`, zod validators, and `proxy.ts`'s matcher (via Next's shipped
   `unstable_doesMiddlewareMatch` + a direct `proxy()` call asserting the
   `/sign-in?redirect=…` redirect).
2. **Services (mock repos + Stripe/Resend, node):** `cart.service` (clamp/currency),
   `catalog.service` (`SlugTakenError`), `order.service` (the retry loop `:73-94`,
   `cancelPaymentIntentQuietly` `:98-106`, `markOrderPaid` 3-way outcome `:240-265`),
   `email.service` (`escapeHtml`, rendered output). Most business-rule coverage lives here.
3. **Repositories (real Postgres, `*.integration.test.ts`):** the crown-jewel cases above.
4. **E2E (Playwright vs build+start, real Postgres, real Stripe test keys):** admin auth
   gate + full checkout (fill Element → confirm → hand-signed webhook POST → assert PAID +
   stock via a direct Prisma read; the "repos only" rule governs `src/**`, not `e2e/**`).
5. **RTL (narrow/optional):** only `CheckoutComplete`'s once-only clear-cart guard.

### CI shape

- Into `verify`, after typecheck: `pnpm exec vitest run --project unit --project dom`
  (mocks only — no service/env change).
- New **`test-db`** job: `postgres:16-alpine` service (matches `docker-compose`), dummy
  secrets, `prisma migrate deploy`, `vitest run --project integration`.
- New **`e2e`** job (`needs: verify`): Postgres service, seed, **real** Stripe test secrets
  as GitHub secrets (`STRIPE_TEST_SECRET_KEY`/`STRIPE_TEST_PUBLISHABLE_KEY`);
  `STRIPE_WEBHOOK_SECRET` can be a plain literal (only the signer/verifier must share it —
  it's never validated against Stripe); Playwright browsers; `pnpm build` (NEXT_PUBLIC_*
  present here) → `playwright test`; upload the report artifact. `.gitignore` +=
  `/playwright-report/`, `/test-results/`.

---

## Findings — Observability & background work

M1 shipped **zero operational infrastructure**: ad-hoc `console.*`, a shallow health
check, and one synchronous in-request email send inside the webhook. There is **no
periodic/background execution mechanism at all**, and **no deploy config exists**
(grepped: no `vercel.json`/`fly.toml`/`Dockerfile`/`render.yaml`/deploy workflow). The
only signal is `ARCHITECTURE.md:75-76`: "Production target: Vercel + Neon/Supabase" — a
stated intent, treated as the target here.

**Logging — bare `pino()`, no transport, server-only.** `pino` (10.3.1) is small, and
**Next 16.3.3 already ships `pino`/`pino-pretty`/`pino-roll`/`thread-stream` in the default
`serverExternalPackages`** (`docs/.../serverExternalPackages.md:76-78,92`) — no
`next.config` change needed. But `pino.transport()` (worker threads) breaks under
Turbopack (`vercel/next.js#84766`, `real-require`); the **bare `pino()` constructor writes
synchronously to stdout with no worker thread**, sidestepping the bug entirely (also the
standard serverless advice — let the platform parse stdout JSON). Put it in
`src/server/observability/logger.ts` with `import "server-only"`; correlate via
`logger.child({requestId,tenant,…})` passed as an optional trailing arg (matches the repo's
explicit-context style; no AsyncLocalStorage refactor). Dev pretty output:
`pnpm dev | pnpm exec pino-pretty` (a devDep, out-of-process), never an in-process
transport.

**Error tracking — do NOT install `@sentry/nextjs` now.** Current 10.73.0 _declares_ Next
16 peer support, but `getsentry/sentry-javascript#19367` (fetched): 10.38.0+ **crashes in
production under Next 16 + Turbopack** (`RangeError: Maximum call stack size exceeded` from
`@opentelemetry/api` chunk duplication); documented workarounds don't fix it; the issue is
closed "not planned". Instead build a thin swappable seam:
`src/server/observability/error-reporter.ts` exporting `reportError(err, context)` that
(1) logs structured, (2) optionally POSTs a compact summary to `ERROR_WEBHOOK_URL`
(Slack/Discord) via `fetch` — solving Vercel Hobby's **1-hour log retention** — and (3) is
wired at `src/instrumentation.ts`'s `onRequestError` hook (stable since v15;
`docs/.../instrumentation.md`), which catches RSC render, route-handler, Server-Action, and
proxy errors in one place. Keep the interface `captureException`-shaped so Sentry can drop
in later without touching call sites.

**Health — fix the layering, split liveness/readiness, skip Prometheus.** Today
`/api/health/route.ts:2,9` imports Prisma and runs `$queryRaw` **directly in a route
handler — a golden-rule #2 violation**. Add `health.repository.ts` (`ping()`) +
`health.service.ts` (DB ping + build info); the route calls the service only. Split
`GET /api/health` (readiness: DB ping, 503 on failure, build/version via
`import {version} from package.json` + `process.env.VERCEL_GIT_COMMIT_SHA?.slice(0,7)`) vs a
new `GET /api/health/live` (liveness: no DB). Prometheus `/metrics` is **not** worth it on
ephemeral Vercel functions — structured logs + readiness + the outbox's own status counts
suffice; `@vercel/otel` is the later upgrade path.

**Background/periodic work — the cross-cutting piece.** Vercel Hobby cron is capped at
**once/day** (too coarse for a cart-abandonment sweep or email retries). **Recommendation:
a GitHub Actions `schedule:` (every ~10 min) as the frequent primary trigger + Vercel Cron
as a durable backstop** (GH Actions scheduled workflows auto-disable after 60 days of repo
inactivity — Vercel covers that gap; precedent: `codeql.yml:8-9` already uses `schedule:`).
Both hit secret-protected `GET /api/cron/*` routes (Vercel Cron always uses GET). Secure
with a `CRON_SECRET` Bearer compared via `timingSafeEqual` in
`src/server/cron/verify-cron-request.ts`; keep `CRON_SECRET` lazy (not in `env.ts`'s strict
schema — a missing value 401s that route, doesn't crash boot). Each route: GET, no
`runtime` export, `maxDuration = 60`, batch-bounded.

**The outbox** (fixes #30/#31, reuses the proven status-guarded-`updateMany` idiom, no
Redis):

```prisma
enum OutboxMessageKind   { ORDER_CONFIRMATION }
enum OutboxMessageStatus { PENDING SENDING SENT DEAD }
model OutboxMessage {
  id String @id @default(cuid())
  tenantId String
  kind OutboxMessageKind
  status OutboxMessageStatus @default(PENDING)
  orderId String
  attempts Int @default(0)
  maxAttempts Int @default(5)
  availableAt DateTime @default(now())   // backoff gate
  claimedAt DateTime?                     // stale-claim recovery
  lastError String?
  sentAt DateTime?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  order  Order  @relation(fields: [orderId], references: [id], onDelete: Cascade)
  @@index([tenantId]); @@index([status, availableAt])
}
```

- **Write path:** inside `markPaidByPaymentIntent`'s existing transaction, `create` an
  `ORDER_CONFIRMATION` row (a pure DB write, safe in the tx). The webhook **stops calling
  Resend directly** — that's what actually fixes #31 (no network call left to delay the
  Stripe ack). No payload snapshot needed (`OrderItem`s are already immutable snapshots —
  re-derive the email from `orderId` at send).
- **Drain** (`outbox.service.ts` via `/api/cron/dispatch-outbox`): recover stale claims
  (`SENDING` older than 5 min → `PENDING`) → select `PENDING & availableAt<=now` (take 25)
  → claim via status-guarded `updateMany` (the "do it right" version is
  `… FOR UPDATE SKIP LOCKED` raw SQL; two-step is an acceptable MVP given low concurrency)
  → per row: fresh order lookup + `sendOrderConfirmation` wrapped in
  `Promise.race([send(), timeout(8000)])` (the Resend SDK has **no** native timeout —
  confirmed in `resend@6.25.0` types) with `idempotencyKey: message.id` (Resend dedupes
  24h) → success `SENT`; permanent error (`EmailNotConfiguredError`) `DEAD`; transient
  → `attempts++`, backoff `min(2^attempts·60s, 1h)`, back to `PENDING` or `DEAD` at
  `maxAttempts`.

**#39 sequences first:** change `env.ts:21-22` (`RESEND_API_KEY`/`EMAIL_FROM`) to
`.optional()` + add `EmailNotConfiguredError`; this unblocks local dev without a Resend key
and gives the outbox its permanent-vs-transient split. Small, isolated, first.

---

## Findings — Commerce hardening

**RBAC.** `requireAdminContext` (`admin-context.ts:33-61`) already resolves and returns
`role`, but no page reads it and `membershipRepository` has only `findForUser`. Add
`requireRole(min)` (redirects underprivileged members to `/admin`) and `assertRole(min)`
(throws `InsufficientRoleError` for Server Actions) next to it — do **not** adopt Next's
`forbidden()`/`unauthorized()` (still `experimental`, need `authInterrupts` flag). Next's
own guidance: re-authorize **inside every Server Action**, render-time gating is not a
security boundary (`docs/.../server-actions.md:87-138`).

> **⚠ Security finding — member-add.** `prisma/seed.ts` creates users via
> `auth.api.signUpEmail`, which is safe only because it's a bare Node script. Calling it
> from an admin Server Action would **overwrite the OWNER's session cookie with the new
> user's session** (a real session-hijack bug): `emailAndPassword` has no
> `autoSignIn:false` (`auth/index.ts:7-14`), so `signUpEmail` creates a session
> (`sign-up.mjs:163-269`), and `nextCookies()`'s `after` hook has `matcher → true`
> (`next-js.mjs:72-99`), unconditionally writing that session cookie onto the current
> request. **Design:** ship **add-existing-user-only** first (`userRepository.findByEmail`
> → create a `Membership` directly; no `signUpEmail` from an admin request); if no user
> exists, tell the OWNER to have them sign up first. Email invitations (an `Invitation`
> model + `databaseHooks.user.create.after`, which runs in the _invitee's_ request) are an
> optional M3 fast-follow. Better Auth's `admin` plugin is a **global** role axis (needs 4
> new `User` columns) that conflicts with this app's per-tenant `Membership.role` — do not
> adopt it.

Guard the **last OWNER**: change-role/remove must refuse to demote/remove a tenant's last
`OWNER` (`countOwners` + `LastOwnerError`). Recommended gates (confirm at plan time): view
orders / mark FULFILLED / cancel PENDING = **STAFF+**; refund = **ADMIN+**; member
management + currency settings = **OWNER-only**. UI hides what a role can't do (thread
`role` through `AdminLayout:14`), and every action re-checks server-side.

**Order lifecycle + refunds.** `FULFILLED`/`CANCELLED`/`REFUNDED` are defined but unwritten
(`schema.prisma:174-180`); `orderRepository` has no list/find-by-id/transition methods. New
methods: `findByIdForTenant`, `listByTenant({status?,page,pageSize})` (add
`@@index([tenantId, createdAt])`), `cancelPendingAndRelease`, `markFulfilled`,
`markRefundedByPaymentIntent` — all atomic, status-guarded `updateMany` like the PAID flip.

- **Refunds (verified vs `stripe@22.6.0` + live docs):** `stripe.refunds.create({payment_intent, reason?, metadata?})`
  (omit `amount` = full refund). **Webhook remains the sole state writer** — initiation
  makes no DB write. Stamp `metadata:{tenantId,orderId}` on the refund so the webhook
  resolves tenant exactly like today. Handle **`refund.created` + `refund.updated` +
  `refund.failed`** (all carry a `Refund`), branch on `refund.status` (`succeeded` →
  `REFUNDED`; `failed` → alert only). **Do not** use `charge.refund.updated` (deprecated)
  or `charge.refunded` (carries a `Charge`, not a `Refund`). Partial refunds are **out of
  scope** (no `PARTIALLY_REFUNDED` status). `src/lib/stripe.ts:16` pins no `apiVersion`
  (SDK default `2026-08-26.dahlia`, current) — fine, minor.
- **`FULFILLED` is a manual attestation, not a real provider call** — there is **no
  shipping address anywhere** in the schema or checkout (`startCheckout` sends no
  `shipping`), and `PrintfulProvider` is an M4 stub. Real fulfillment (+ address
  collection) is M4; M2's "Mark fulfilled" only flips status. Restocking on refund is **not
  automatic** (goodwill vs return is ambiguous) — left to the manual product-edit form.
- **Soft-404 caution:** a sibling `loading.tsx` already makes `/admin/products/[id]`'s
  `notFound()` return 200 (`docs/.../loading.md:76,101-118`). **Don't** add a
  file-convention `loading.tsx` at `/admin/orders/`; use an inline `<Suspense>` in the list
  page if a skeleton is wanted.

**Inventory reservation.** Add **`ProductVariant.reserved Int @default(0)`** as a running
counter kept **separate** from `stock` (`stock` = physical units the admin typed;
`available = stock - reserved` = sellable). Prisma's query builder can't compare two
columns, so the guard needs **parameterized `$executeRaw`** (a new but justified pattern;
tagged-template = safe, not `$executeRawUnsafe`):

- **Reserve at `startCheckout`** (fold into `createWithItems`'s transaction, lines sorted
  by `variantId`): `UPDATE "ProductVariant" … SET reserved = reserved + qty … WHERE stock -
reserved >= qty` (joined to `Product` for the tenant scope); 0 rows → throw
  `InsufficientStockError` (propagates through the existing catch that already cancels the
  orphaned PaymentIntent; map to "sold out at checkout" UX in
  `checkout/actions.ts:41-54`).
- **Release on CANCELLED** (admin or the sweep): `SET reserved = GREATEST(reserved - qty, 0)`.
- **Reconcile at PAID:** keep the existing oversell-guarded `stock` decrement **exactly
  as-is** (preserves the tested shortfall logic) and add a **separate best-effort**
  `reserved` release right after — isolates all new risk to one additive statement.
- **Backorder: block** (allowing sale below zero available would defeat the reservation).
  Update `available`-based reads: `cart.service.ts:34-39,72,121`,
  `purchase-panel.tsx:44,53-54,79,110-111`, `product-card.tsx:33`.
- **Rejected alternatives:** deriving reserved from PENDING orders (can't make
  check-then-reserve atomic without locking → reintroduces the race); a `StockReservation`
  ledger table (`Order`+`OrderItem` already _is_ the ledger; the counter is just its
  atomically-maintained cache).

**Lean analytics.** `/admin` is a stub. Add `analytics.repository.ts` +
`analytics.service.ts` (page calls the service only): `revenueTotal` (`aggregate _sum
totalCents WHERE status IN (PAID, FULFILLED)` — excludes REFUNDED/CANCELLED),
`countsByStatus` (`groupBy status`), `lowStockVariants` (reuse `orderRepository.listByTenant`
for "recent orders"). Hoist `LOW_STOCK_THRESHOLD` from `purchase-panel.tsx:26` into
`config/constants.ts`; once reservation ships, low-stock reads `available`. **Sparkline/
time-series: defer to M3** (needs `date_trunc` raw SQL or app bucketing; no chart precedent
in `DESIGN.md`).

**Carried-over tie-ins.** **#35** — `/admin/settings` (OWNER-only) with a currency
`<Select>` reusing `CURRENCIES` from `catalog.ts:24-31`, a new
`tenantRepository.updateCurrency`, and an explicit "existing prices aren't converted"
warning (`Order.currency` already snapshots per-order). **#40** — two cheap fixes: thread
the already-computed `StockShortfall[]` into the confirmation email for distinct copy, and
add **`Order.oversold Boolean @default(false)`** (set in the PAID transaction when
`shortfalls.length>0`) surfaced on the order-detail page before an admin marks it
FULFILLED.

**Schema changes (all additive with `@default` → metadata-only, migration-safe; contrast
the still-open #38):**

```prisma
model ProductVariant { reserved Int @default(0) }
model Order { oversold Boolean @default(false)  @@index([tenantId, createdAt]) }
// + OutboxMessage (above); optional-M3: Invitation
```

---

## Risks & unknowns (consolidated)

| Risk                                                                                | Mitigation                                                                                                                                          |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Session-hijack** if `signUpEmail` is called from an admin action                  | Add-existing-user-only first; invites (if ever) create the user in the invitee's own request via `databaseHooks.user.create.after`.                 |
| `@sentry/nextjs` crashes on Next 16 + Turbopack (#19367, upstream unresolved)       | Don't install; ship the thin `reportError` seam; revisit when Sentry confirms a fix.                                                                |
| `pino.transport()` breaks under Turbopack (#84766)                                  | Bare `pino()` only (sync, no worker thread); already in Next's default `serverExternalPackages`.                                                    |
| `server-only`/`next/headers`/`env.ts` all throw under Vitest                        | `resolve.alias` shim + `vi.mock("next/headers")` + a `setupFiles` dummy-env block mirrored from `ci.yml`.                                           |
| Reservation race / drift                                                            | One atomic `$executeRaw` guard per line, lines ordered by `variantId`; `GREATEST(...,0)` release floor; the PAID `stock` guard stays authoritative. |
| Vercel Hobby cron = 1×/day; GH Actions auto-disables after 60 days idle             | GH Actions `schedule:` (10 min) primary + Vercel Cron backstop; all ops reconciliation-based, so a missed/duplicated run is a safe no-op.           |
| `NEXT_PUBLIC_*` inlined at build → E2E Element won't mount if the key is start-only | Set the real test key at the **job** `env:` level, covering `pnpm build`.                                                                           |
| Soft-404 on new `/admin/orders/[id]`                                                | No file-convention `loading.tsx` at `/admin/orders/`; inline `<Suspense>` only.                                                                     |
| `FULFILLED` implies a shipment but no address exists                                | Explicit M2 non-goal: manual status attestation only; real fulfilment + address = M4.                                                               |
| Currency change doesn't convert existing prices                                     | On-page warning; `Order.currency` snapshot protects history.                                                                                        |
| Refund role level                                                                   | Recommend ADMIN+ — flagged for confirmation at plan time.                                                                                           |

## Recommended approach

Sequence roughly: **(0)** unblock — `#39` email-optional first (clears local dev + the
outbox's error split). **(1) Test harness early** so every later PR lands with tests —
Vitest setup → pure/service tests → integration + `test-db` CI → Playwright + E2E. **(2)
Observability foundations** (logger + error seam + health) in parallel — small, unblock
structured logs for everything after. **(3) Background spine** — cron harness → outbox
(closes #30/#31). **(4) Inventory reservation** (schema + reserve/release/reconcile) → the
**sweep** (closes #25) once both the cron harness and the release primitive exist. **(5)
RBAC** (`requireRole` + members page) → **currency settings** (closes #35). **(6) Order
lifecycle** (state machine + `oversold`) → **refund webhook** → **admin orders UI** (closes
#40). **(7) Lean analytics** last (reuses the orders read). Standalone anytime: **#38**
(migration safety), **#27** (Payment Element dark mode).

The two `$executeRaw` reservation guards and the outbox drain are the only genuinely novel
patterns; everything else mirrors M1's atomic/idempotent/status-guarded repository style.

## Issue plan → GitHub

**14 new issues to create** (each ≈ one PR), plus the 9 carried-over already on the board.
Several carried-over issues are **closed by** a new PR rather than worked separately.

| Theme                  | New issues                                                                                                                                                                              | Closes (carried)                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Tests                  | Vitest harness + pure-logic unit tests (+CI); Service unit tests; Repo integration tests + `test-db` CI (+#41 txn timeout); Playwright harness + auth-gate E2E; Checkout E2E + `e2e` CI | #41                                                                 |
| Observability          | Logging + error-reporting seam; Health/readiness rework                                                                                                                                 | —                                                                   |
| Reliability            | Cron harness                                                                                                                                                                            | —                                                                   |
| Inventory              | Inventory reservation                                                                                                                                                                   | —                                                                   |
| RBAC                   | `requireRole`/`assertRole` + members admin page                                                                                                                                         | —                                                                   |
| Order lifecycle        | State machine + `oversold` (backend); Admin orders list+detail UI; Stripe refunds (initiate + webhook)                                                                                  | #40                                                                 |
| Analytics              | Lean `/admin` dashboard                                                                                                                                                                 | —                                                                   |
| **Use existing**       | —                                                                                                                                                                                       | #25 (sweep), #30/#31 (outbox), #35 (currency), #39 (email-optional) |
| **Standalone carried** | —                                                                                                                                                                                       | #27 (dark mode), #38 (migration safety)                             |

## References

- **Next 16 (installed docs):** `testing/vitest.md`, `testing/playwright.md`,
  `upgrading/version-16.md`, `environment-variables.md`, `server-actions.md`,
  `file-conventions/{instrumentation,loading,route}.md`,
  `config/next-config-js/serverExternalPackages.md` (all under `node_modules/next/dist/docs/01-app/`).
- **Source verified (installed):** `server-only/{index.js,package.json}`,
  `next/dist/server/request/cookies.js`, `stripe@22.6.0` `Webhooks.*`/`Refunds.d.ts`/
  `Events.d.ts`/`apiVersion.js`/`NodePlatformFunctions.js`, `better-auth@1.7.2`
  `sign-up.mjs`/`integrations/next-js.mjs`/`plugins/admin/*`, `@better-auth/core`
  `init-options.d.mts`, `resend@6.25.0` `index.d.mts`, `@prisma/client` `library.d.ts`.
- **Live lookups (2026-09-01):** Sentry `getsentry/sentry-javascript#19367`; pino
  `vercel/next.js#84766`; Vercel [Cron](https://vercel.com/docs/cron-jobs),
  [Runtime Logs](https://vercel.com/docs/logs/runtime),
  [System env vars](https://vercel.com/docs/environment-variables/system-environment-variables);
  Stripe [Refunds](https://docs.stripe.com/refunds),
  [Event types](https://docs.stripe.com/api/events/types); vitest.dev (4.1.11);
  playwright.dev (ci-intro, browsers); GitHub Actions Postgres service containers +
  scheduled-workflow 60-day auto-disable.
- **Repo:** `docs/ARCHITECTURE.md`, `docs/DESIGN.md`,
  `docs/milestones/M1-commerce-slice/{handoff,research}.md`, `.github/workflows/{ci,codeql}.yml`,
  `docker-compose.yml`, and the `src/**` files cited inline above.
