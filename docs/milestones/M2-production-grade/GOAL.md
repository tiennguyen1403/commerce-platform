# M2 — Production-grade

Harden the M1 commerce slice into something production-grade: automated tests, operational
visibility, reliable delivery, real access control, and a proper order lifecycle — the
reliability/quality bar a live store needs. Scope was set at `/milestone-start` to a
**focused hardening** milestone (depth over breadth): catalog **search** and a **full
analytics dashboard** are deferred to M3. See [`research.md`](research.md).

## In scope

- **Tests** — Vitest unit (pure logic + services with mocked repos) + repository
  integration tests against real Postgres (the atomic PAID/stock guards) + Playwright E2E
  (admin auth gate, full checkout → PAID via a hand-signed webhook), all green in CI.
- **Observability** — structured logging (`pino`, server-only), an error-reporting seam
  (`instrumentation.ts` `onRequestError`; no Sentry — broken on Next 16 + Turbopack), and a
  real health/readiness endpoint (via a repository, split from liveness).
- **Reliability** — a DB-backed **email outbox** with retry/backoff drained by a scheduled
  job; the Stripe webhook no longer makes a blocking email call; missing email config no
  longer crashes boot.
- **Background work** — a secret-protected cron harness (GitHub Actions primary + Vercel
  Cron backstop) hitting `/api/cron/*`; used by the outbox drain and the PENDING sweep.
- **Inventory** — reserve stock at `PENDING` (`ProductVariant.reserved`,
  `available = stock - reserved`), release on cancel/sweep, reconcile at PAID; backorder
  blocked; oversell still detected/surfaced.
- **RBAC surfacing** — enforce and expose `OWNER > ADMIN > STAFF` in the admin UI:
  `requireRole`/`assertRole` (server-side, defense-in-depth), role-aware nav, an OWNER-only
  members page (add existing user / change role / remove, last-owner protected), and
  OWNER-only store settings.
- **Order lifecycle** — expand beyond `PENDING → PAID`: admin order list + detail; mark
  `FULFILLED` (manual attestation — see caveat), cancel `PENDING`, and issue Stripe refunds
  confirmed by the refund webhook (`REFUNDED`).
- **Lean analytics** at `/admin` — revenue (PAID + FULFILLED), order counts by status,
  low-stock variants, recent orders. No charts (deferred).
- **Carried-over M1 fixes** — #25, #27, #30, #31, #35, #38, #39, #40, #41.

## Out of scope (later milestones)

Catalog **search** and a **full analytics dashboard / time-series** (M3); subdomains /
theming / onboarding / Stripe Connect (M3); Printful / POD fulfilment + shipping-address
collection (M4); email **invitations** for non-existing users (optional M3 fast-follow);
partial refunds; automatic restocking on refund.

> **Caveat — "Mark fulfilled" is a manual status attestation, not a real fulfilment call.**
> There is no shipping address anywhere in the schema/checkout yet, and the fulfilment
> provider is an M4 stub. Real fulfilment (and address collection) is M4; M2 only flips the
> order status so an operator can track it.

## Exit criteria

- [ ] **Tests run green in CI** — Vitest unit + service tests, repository integration tests
      on a real Postgres service (incl. a concurrent double-delivery test asserting exactly
      one PAID transition), and Playwright E2E for the admin auth gate and the full
      checkout → PAID flow.
- [ ] **Order lifecycle beyond PAID** — an admin can view orders (list + detail), mark a
      PAID order FULFILLED, cancel a PENDING order, and issue a refund; `REFUNDED` is driven
      by the Stripe **refund webhook**, not the client. Every transition is atomic,
      idempotent, and tenant-scoped.
- [ ] **Inventory reserved at PENDING** and released on cancel/sweep; backorder blocked;
      oversell at PAID still detected and surfaced (#40); abandoned PENDING orders swept
      (#25).
- [ ] **RBAC enforced and surfaced** — server-side role gates on every privileged action
      (defense-in-depth), role-aware admin nav, OWNER-only member management (last-owner
      protected) and currency settings (#35).
- [ ] **Observability** — structured logging replaces ad-hoc `console.*`; an
      error-reporting seam captures unhandled server errors; `/api/health` is a real
      readiness check via a repository (not direct Prisma) with a separate liveness
      endpoint.
- [ ] **Reliable email** — order-confirmation email goes through the DB-backed outbox with
      retry/backoff, drained by the scheduled job; missing email config no longer crashes
      boot (#39); the webhook makes no blocking email call (#31).
- [ ] **Lean analytics** at `/admin` — revenue, counts-by-status, low-stock, recent orders,
      tenant-scoped, with no Prisma in the page.
- [ ] **Carried-over M2 fixes closed** — #25, #27, #30, #31, #35, #38, #39, #40, #41.
- [ ] `pnpm build`, `pnpm typecheck`, `pnpm lint`, and the full test suite green; CI passing
      on `development`.

## Plan & issues

**14 new issues (#46–#59)** created at `/milestone-start`, plus the 9 carried-over (#25,
#27, #30, #31, #35, #38, #39, #40, #41) already on GitHub Milestone **M2 —
production-grade** (#2). Trunk is `development`; each issue is one `feat/…`/`fix/…`/`test/…`
branch → PR that `Closes #<issue>`.

Recommended build order (dependencies in parens):

1. **#39** — email config optional at boot _(unblocks local dev + the outbox)_.
2. **#46** Vitest harness + unit tests → **#47** service tests → **#48** repo integration +
   `test-db` CI _(closes #41)_.
3. **#51** logging + error seam · **#52** health rework _(parallel, small)_.
4. **#53** cron harness → **#30** email outbox _(closes #30, #31)_.
5. **#54** inventory reservation → **#25** abandoned-PENDING sweep _(needs #53 + #54)_.
6. **#55** RBAC + members → **#35** currency settings.
7. **#56** order state machine _(needs #54)_ → **#57** refunds → **#58** admin orders UI
   _(closes #40)_.
8. **#49** Playwright + auth-gate E2E → **#50** checkout E2E + `e2e` CI _(once the flows
   above are stable)_.
9. **#59** lean analytics _(needs #56)_. Standalone anytime: **#38**, **#27**.

See [`research.md`](research.md) for the full brief.
