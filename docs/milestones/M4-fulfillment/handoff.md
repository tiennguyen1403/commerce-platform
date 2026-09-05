# Handoff — M4 Fulfillment

> Written at milestone close (by the `scribe` agent).

Turns the platform's manual "Mark fulfilled" attestation into **real fulfillment**: a
shopper supplies a validated shipping address at checkout, a PAID order is submitted to a
print-on-demand provider (a deterministic mock in dev/CI, Printful v1 in production)
through the transactional outbox behind a two-layer idempotency guard, a background cron
polls the provider and reconciles a shipped order to `FULFILLED` with carrier + tracking,
a shipping-confirmation email goes out, and both the admin order detail and the shopper's
own order history show the address, status, and tracking. What began as a nine-issue
vertical slice grew to twenty-one as the poll cron's failure taxonomy — a provider
cancelling after submission, a shipment stuck in a non-terminal hold, tracking that can't
be read at all — surfaced its own alerting, UI, and fairness follow-ups; see
[Why the milestone grew from 9 to 21 issues](#why-the-milestone-grew-from-9-to-21-issues)
below.

## Shipped

- **Shipping address at checkout** (#135, PR #145) — `src/lib/validators/checkout.ts:18,40-96`:
  a `SHIPPING_COUNTRIES = ["US"] as const` allowlist (documented as an easy, deliberate
  fast-follow to widen) feeding `shippingAddressSchema`, with US-only state/ZIP refinements.
  Re-validated server-side in the Server Action (`checkout/actions.ts:32` — the client form's
  check is UX only) and persisted in the SAME create transaction via `shippingAddressColumns`
  (`order.repository.ts:130-140,338-363`), so an order never exists without its address. The
  Stripe PaymentIntent itself carries no address (`order.service.ts:579-591`) — our form is
  the sole source of shipping data. Works identically for guest and signed-in checkout
  (`checkout/actions.ts:46-47` resolves `userId` from the session, never the client).
- **Fulfillment schema foundation** (#134, PR #144) — the base migration
  `20260904042456_fulfillment`: the `FulfillmentStatus` enum, `Order`'s `ship*` /
  `fulfillment*` / `tracking*` columns, `ProductVariant.providerVariantId`, and two new
  `OutboxMessageType` values (`FULFILLMENT_SUBMISSION`, `SHIPPING_CONFIRMATION`). Five more
  migrations followed as the poll cron's failure taxonomy grew (below) — **six** in total,
  every one additive; see `docs/DATABASE.md`.
- **Provider abstraction** (#137, PR #147) — `src/server/fulfillment/provider.ts:87-91`
  defines `FulfillmentProvider` (`createOrder`/`getTracking`); `MockProvider` (`mock.ts:77`)
  is a deterministic, in-memory CI/test default and dev fallback (no network, no real
  credentials); `getFulfillmentProvider()` (`index.ts:48-55`) selects it by
  `PRINTFUL_API_KEY` presence — real provider with a key, mock in dev/test without one,
  `null` (unconfigured) in production without one — so CI never calls a real provider.
- **Catalog mapping** (#136, PR #146) — `ProductVariant.providerVariantId`
  (`catalog.ts:75-79`: free-form, trimmed, length-capped, blank-valid), settable in the admin
  product/variant form and persisted tenant-scoped (`product.repository.ts:221,316,332`);
  the submission service resolves `sku → providerVariantId` (`fulfillment.service.ts:706-727`
  `toLineItems`) so the adapter stays a thin HTTP client, never a second catalog.
- **Printful v1 adapter** (#138, PR #149) — `printful.ts:142` `PrintfulProvider`, verified
  against the live v1 OpenAPI spec: Bearer auth, `POST /orders?confirm=1` (one-call
  submit+charge — Stripe already captured payment, so Printful's draft/confirm review buffer
  buys nothing). A 400 is a resolved soft-`"failed"` with a synthesized placeholder id that
  must never reach `getTracking` (`printful.ts:192-207`); a 401/419/429/5xx or network/timeout
  throws for the outbox to retry with backoff, then dead-letter (`printful.ts:209-217`).
- **Idempotent outbox submission** (#139, PR #150) — `FULFILLMENT_SUBMISSION` is enqueued in
  the SAME PENDING → PAID transaction, only when the order carries a complete address
  (`order.repository.ts:743-752`, gated by `hasShippingAddressColumns`). Idempotency is two
  layers, because a duplicate POD order is real money + a physical shipment: the outbox
  message's own atomic claim (`outbox.service.ts:240`), plus an order-level
  `NOT_SUBMITTED → SUBMITTING` claim gated on `status: "PAID"` too
  (`order.repository.ts:1032-1046`) — so a refunded or hand-fulfilled order can never be
  submitted. A permanent `FulfillmentError` (unconfigured, unmapped, missing address,
  provider soft-reject) records the order `FAILED` before rethrowing so the outbox
  dead-letters it; a transient fault propagates untouched for retry.
- **Poll-fulfillment cron — reconciliation to `FULFILLED`** (#140, PR #152) —
  `/api/cron/poll-fulfillment` → `fulfillmentService.pollOpenShipments`. "Shipped" is
  signalled provider-agnostically by a tracking **number**, never the raw status string;
  `markShipped`, guarded on `{status: "PAID", fulfillmentStatus: "SUBMITTED"}`, persists
  carrier/tracking and flips PAID → FULFILLED — now the sole writer of that transition,
  mirroring the refund webhook's sole ownership of `REFUNDED` — enqueuing
  `SHIPPING_CONFIRMATION` in the SAME transaction (`order.repository.ts:1128-1169`, email at
  `:1159-1166`). Registered in `.github/workflows/cron.yml:46` and `vercel.json:6`. The
  manual "Mark fulfilled" button stays as a documented override, with updated copy
  (`orders/order-actions.tsx:92`).
- **Shipping-confirmation email** (#141, PR #153) — `emailService.sendShippingConfirmation`
  (`email.service.ts:449`), delivered through the same outbox drain
  (`outbox.service.ts:139-160`) as the order-confirmation email. Every shopper-visible value
  (store name, item titles, address lines, carrier, tracking URL) is `escapeHtml`'d, and the
  tracking link is only ever rendered when it's escaped into the `href` too.
- **Tracking surfaced in admin + shopper UI** (#142, PR #166) — admin order detail shows
  provider status, provider order id, carrier, tracking (with a clickable link), and the
  shipping address (`orders/[id]/page.tsx:242-306`, behind `requireAdminContext`); the
  shopper's `/account/orders/[id]` (`account/orders/[id]/page.tsx:61-202`), scoped by BOTH
  `tenantId` and the session-proven `userId` via `getOrderForUser`, shows a plain-language
  shipment status, tracking link, and address — never internal fulfillment states or
  provider ids. `trackingHref()` (`validators/orders.ts:306`) gates any tracking link to
  http(s). A same-branch fixup commit stops a "flagged stuck" banner from lingering on an
  order that has since shipped.
- **Printful retail price + currency** (#148, PR #156; #157, PR #160) — the `OrderItem`'s
  per-unit `priceCents` (a purchase-time snapshot, never the live variant price) threads onto
  the Printful line's `retail_price` (`toRetailPrice`, `printful.ts:298-300` — the sole
  cents→decimal-string crossing), so the customer-facing packing slip shows our price, not
  Printful's own base price. `retail_costs.currency` (`toRetailCurrency`, `printful.ts:311-313`)
  frames that slip in the order's own currency rather than the single platform Printful
  store's default — the only per-order currency lever v1 exposes; true per-currency
  settlement stays deferred (see the decision log).
- **Poll cron's stuck-open-shipment cluster** (#155 PR #159, #158 PR #165, #161 PR #167,
  #162 PR #168, #164 PR #173) — an order left `SUBMITTED` past
  `FULFILLMENT_STUCK_THRESHOLD_DAYS` (default 10 days, env-tunable, `env.ts:68-75`) is
  flagged exactly once via the write-once `Order.fulfillmentStuckAt`
  (`markFulfillmentStuck`, `flagIfStuck` in `fulfillment.service.ts:485-544`), snapshotting
  the raw provider hold status for the admin view. The flagged tail is deprioritised behind
  fresh orders in `findSubmittedForPolling`'s `orderBy` and rotated fairly via the nullable
  `fulfillmentStuckPolledAt` re-poll key (`markStuckRepolled`), so a backlog past
  `POLL_BATCH_SIZE` can't permanently starve the newest-flagged order. Alert-only: the order
  stays SUBMITTED and keeps being polled — an `onhold`/`inreview` hold may still ship.
- **Poll cron's erroring-open-shipment cluster** (#163 PR #169, #170 PR #174, #171 PR #176,
  #172 PR #177, #175 PR #178) — a `getTracking` call that throws on every poll (a bad/stale
  external id, a persistent provider fault) is counted via `Order.fulfillmentErrorCount` and
  alerted exactly once when it equals `FULFILLMENT_ERROR_ALERT_THRESHOLD` (default 144,
  ≈ 24h at the 10-minute cron cadence; env-tunable, `env.ts:96-103`; exported as
  `ERROR_POLL_ALERT_THRESHOLD`, `fulfillment.service.ts:105`, so tests assert against the
  same source of truth). A clean poll resets the streak. The erroring order is sunk into
  its own deprioritised, fairly-rotated tier (`fulfillmentErrorPolledAt`) sorted between the
  fresh and flagged-stuck tiers, and surfaced in the admin UI (`fulfillmentErrorAttention`,
  `validators/orders.ts:181`) alongside the stuck banner (`fulfillmentAttention`,
  `validators/orders.ts:120`) — the two are independent signals and can both fire on one
  order.
- **Terminal-fail exit** (#151, PR #154) — a provider-reported cancel/fail AFTER submission
  (`TrackingInfo.terminalFailure`, provider-agnostic — each adapter maps its own vocabulary
  onto it) reconciles `SUBMITTED → FAILED` (`markFulfillmentFailedAfterSubmission`,
  `order.repository.ts:1206-1230`) instead of being re-polled forever. `Order.status` stays
  PAID so an operator decides refund vs. re-order — the fulfillment-side twin of the
  oversell/refund-failed alerts, logged at `error` for the same reason (nothing routes
  through `reportError`, and `warn` ages out of Vercel Hobby's 1-hour log retention).

## Exit criteria

All twelve checklist items in `GOAL.md` — the source of truth, condensed below with
evidence.

- [x] **Shipping address at checkout** — a shopper supplies a shipping address, validated
      server-side (zod + `SHIPPING_COUNTRIES`), persisted on `Order` in the same transaction
      as order creation; the Stripe PaymentIntent still collects none; guest and signed-in
      both work — PR #145 (#135): `checkout.ts:18,40-96`, `checkout/actions.ts:32,46-47`,
      `order.repository.ts:338-363`, `order.service.ts:579-591`.
- [x] **Schema, migration-safe** — six forward-only migrations (not the one originally
      planned — a direct artifact of the follow-up expansion), every `NOT NULL` addition
      carrying a `DEFAULT` (`fulfillmentStatus`, `fulfillmentErrorCount`), every other
      addition nullable; `pnpm db:check-migrations` passes in CI
      (`.github/workflows/ci.yml:36`) — PR #144 (#134) + the five follow-on migrations (see
      Shipped above); full detail in `docs/DATABASE.md`.
- [x] **Provider abstraction** — `MockProvider` and `PrintfulProvider` both implement
      `FulfillmentProvider`; `PRINTFUL_API_KEY` is optional, validated at use
      (`printful.ts:121-124`) not boot (`env.ts:53`); the selector
      (`index.ts:48-55`) defaults to the mock in CI — PR #147 (#137), PR #149 (#138).
- [x] **Catalog mapping** — `providerVariantId` settable per variant in the admin form,
      persisted tenant-scoped, resolved by the service (never the adapter) — PR #146
      (#136): `catalog.ts:75-79`, `product.repository.ts:221,316,332`,
      `fulfillment.service.ts:706-727`.
- [x] **Idempotent submission** — enqueued only with a complete address, never
      double-submitted (outbox claim + order-level `SUBMITTING` guard gated on PAID),
      unconfigured/unmapped/soft-rejected resolves to `FAILED` (surfaced, not retried
      forever), the provider's external id persisted — PR #150 (#139):
      `order.repository.ts:743-752,1032-1046`; integration-tested
      (`fulfillment.service.integration.test.ts`, `order.repository.integration.test.ts`).
- [x] **Reconciliation + `FULFILLED`** — the poll cron reconciles provider status, persists
      carrier + tracking, flips PAID → FULFILLED via a guarded transition, registered in
      both schedulers; `FULFILLED` now means provider-confirmed shipped; the manual
      override stays with updated copy — PR #152 (#140): `order.repository.ts:1128-1169`,
      `cron.yml:46`, `vercel.json:6`, `order-actions.tsx:92`.
- [x] **Shipping email** — `SHIPPING_CONFIRMATION` enqueued in the SAME transaction as the
      FULFILLED reconcile, delivered by the existing outbox drain — a shipped order can
      never exist without its email queued — PR #153 (#141): `order.repository.ts:1159-1166`,
      `email.service.ts:449`.
- [x] **Tracking surfaced** — admin order detail and shopper `/account/orders/[id]` both
      show address, fulfillment status, and tracking link; tenant/user scoping unchanged, no
      Prisma in either page — PR #166 (#142): `orders/[id]/page.tsx:242-306`,
      `account/orders/[id]/page.tsx:61-202`.
- [x] **Tenancy, layering, money** — every fulfillment write is `{id, tenantId}`-scoped;
      `findSubmittedForPolling` is the sanctioned platform-wide cron read (mirroring
      `sweep-orders`/`dispatch-outbox`), each row still carries its own `tenantId` and every
      write re-scopes by it; no Prisma outside repositories; money stays integer cents, with
      the sole decimal crossing at the outbound HTTP edge
      (`toRetailPrice`, `printful.ts:298-300`).
- [x] **Tests green in CI** — `fulfillment.service.test.ts` (unit, against the mock),
      `fulfillment.service.integration.test.ts` + `order.repository.integration.test.ts`
      (the `SUBMITTING` claim, the poll reconcile, real Postgres), `e2e/checkout.spec.ts`
      (the address round-trips onto the order row) — `verify` + `test-db` + `e2e` green on
      `development` @ `318c484` (GitHub Actions).
- [x] **Quality gates** — `pnpm build`, `pnpm typecheck`, `pnpm lint`, and the full test
      suite green; CI passing on `development` — same run as above, independently confirmed
      locally.
- [x] **Docs** — `research.md` + `GOAL.md` (produced at `/milestone-start`, PR #143), the
      `docs/ARCHITECTURE.md` §6 rewrite + decision log (this handoff), `docs/DATABASE.md`
      (all six migrations), the Printful operator-setup + `confirm:false` smoke test
      (`docs/milestones/M4-fulfillment/printful-setup.md`), `handoff.md` (this file).

## Key decisions

Also appended to the `docs/ARCHITECTURE.md` §8 decision log.

- **Provider seam: a `FulfillmentProvider` interface, mock-first** — a deterministic
  `MockProvider` is the CI/test default and dev fallback; the real `PrintfulProvider` (v1
  REST) is selected purely by `PRINTFUL_API_KEY` presence. Nothing above the provider
  boundary — checkout, the outbox, the poll cron — changes when the real adapter turns on.
- **Tracking is polled, not webhook-driven** — a pull-shaped `getTracking(externalId)`
  against a new authenticated `/api/cron/poll-fulfillment`, copying the
  `sweep-orders`/`dispatch-outbox` house style, because Printful v1's webhook-signing story
  isn't clearly documented. Push-based tracking is a deliberately deferred fast-follow.
- **Shipping address flattened onto `Order`**, not a separate `Address` model — matches the
  `OrderItem` snapshot philosophy and avoids a join on every order read; every new column is
  nullable or carries a `DEFAULT`, so it's safe on the non-empty table by construction.
- **Submission reuses the transactional outbox** (`FULFILLMENT_SUBMISSION`) plus a
  **second, order-level `SUBMITTING` guard** — two-layer idempotency, because a duplicate
  POD order is real money and a physical shipment, unlike a duplicate email that a resend
  merely annoys. Any non-clean outcome after the claim fails toward "stuck, a human
  reconciles," never toward a silent re-submit.
- **`FULFILLED` redefined**: from "an admin attested this shipped" (M2) to
  "the provider confirms it shipped" — driven solely by the poll cron's guarded
  `PAID → FULFILLED` transition, mirroring how the verified Stripe webhook is the sole
  writer of `REFUNDED`. The manual "Mark fulfilled" button is kept as a documented
  override for non-POD items or a provider outage; its copy says so.
- **`ProductVariant.providerVariantId`** maps our free-form `sku` to the provider's opaque
  catalog id; the submission **service** resolves it via the repository, so the provider
  adapter stays a thin HTTP client, never a second catalog.
- **`PRINTFUL_API_KEY` is optional** — the `RESEND_API_KEY` posture: validated at use, never
  at boot, server-only, never `NEXT_PUBLIC_*`. A missing key must never block checkout/boot;
  it only narrows what fulfillment can do.
- **Emergent: the poll cron became a provider-state reconciliation state machine** — not
  planned at `/milestone-start`. A real polling loop against an external POD provider
  surfaces a taxonomy of never-resolving outcomes, not just "shipped" — terminal cancel/fail
  after submission (#151), a non-terminal hold that never resolves (#155), and tracking that
  can't be read at all (#163) — and each earns a proactive, alert-once, ERROR-level log (the
  same money-at-risk severity convention as the oversell/refund-failed alerts), a durable
  "alert once" marker, an admin surface, and a place in a now-3-tier fair poll ordering
  (fresh < erroring < flagged-stuck, each tier rotated by a nullable re-poll timestamp,
  `fulfillmentErrorPolledAt` / `fulfillmentStuckPolledAt`, sorted NULLS FIRST so an
  unflagged/error-free order always sorts first). Both alert thresholds are env-tunable
  (`FULFILLMENT_STUCK_THRESHOLD_DAYS`, `FULFILLMENT_ERROR_ALERT_THRESHOLD`) and explicitly
  provisional pending real Printful timing data.

## Why the milestone grew from 9 to 21 issues

**Planned: 9** (#134–142, all created at `/milestone-start` on 2026-09-04 between 03:58:46
and 03:59:05) — one clean vertical slice: schema → checkout address → catalog mapping →
mock provider → Printful adapter → outbox submission → poll reconcile → shipping email →
UI.

**Shipped: 21.** The twelve follow-ups (#148, #151, #155, #158, #161–164, #170–172, #175)
were all filed during the single build day, 2026-09-04, between 07:57:58 (#148) and
20:27:12 (#175) — none planned up front. (A thirteenth, #157, was also filed and closed
that day but never tagged to the milestone; it was folded into #160's PR alongside #148's
work and doesn't count toward the 21.)

**Root cause.** One planned issue — #140, "poll-fulfillment cron reconciles provider
status → FULFILLED" — was written as a happy-path task but is really a _provider-state
reconciliation state machine_. A real polling loop against an external POD provider has a
taxonomy of non-happy outcomes, and **eleven of the twelve follow-ups descend from it**:
#151 (terminal-fail); #155 (a non-terminal hold, `onhold`/`inreview`, open too long) →
sub-tree #158, #161, #162, #164; #163 (tracking itself unreadable — `getTracking` throws
every poll) → sub-tree #170, #171, #172, #175. (#163's own issue title cross-references
#155/#158 — the stuck-tree work is what prompted noticing this second, independent failure
mode — but structurally it's its own branch of the taxonomy, not a child of #155.) #148 is
the twelfth — a Printful money-format detail (retail price + currency on the packing
slip), unrelated to polling.

**The multiplier.** #155 (stuck) and #163 (erroring) are mirror-image failure modes, and
each one — once you decide to alert on it — forces the SAME four secondary issues: (1)
surface it in the admin UI (#161 / #171); (2) deprioritise/back off its re-poll so it can't
hog the batch (#158 / #170); (3) make the threshold env-tunable (#162 / #172); (4) keep the
deprioritised tail fair/round-robin so nothing starves (#164 / #175). Two detected modes ×
(1 detection issue + 4 operational follow-ups) ≈ 10 issues, plus #148 and the original #140
= 12.

**Honest assessment.** Roughly half were essential — you cannot ship a reconciliation loop
that only handles the happy path; an order with captured money that silently never ships
and never alerts is a real production defect (#151, #155, #163, #161, #171, #148). Roughly
half were legitimate-but-deferrable operational polish: #158/#164 and #170/#175 tune the
fairness of a poll batch that, at this project's scale, will realistically never exceed
`POLL_BATCH_SIZE`; #162/#172 (env-tuning) are honest but could have ridden their parent
issues instead of becoming their own. The cascade was self-similar and reviewer-driven —
each fix's review surfaced the next edge case (#158→#164, #170→#175) — and cheap
issue-creation turned every reviewer nit into its own issue: great for clean, atomic PRs
and a legible history (real portfolio value), but it inflates the count and can read as
thrash from the outside.

**Lesson.** A sharper `/milestone-start` would have decomposed the poll cron up front into
`{happy → FULFILLED, terminal-fail, stuck-non-terminal, tracking-erroring}` and explicitly
deferred the scheduling-fairness refinements behind real provider telemetry — turning
~10 emergent issues into ~4 planned plus a documented "defer until we have real Printful
timing data" note. Tellingly, this very handoff review surfaced yet another symmetric gap
(stranded-`SUBMITTING`, #179 — see Known issues below) and the disciplined call was to
**defer** it, not spawn a follow-up #22.

## Known issues / tech debt

Two independent review passes ran at handoff. The built-in `security-review` skill came
back **clean** — no high-confidence vulnerabilities across cron auth (`poll-fulfillment`
reuses `verifyCronRequest` — timing-safe, fail-closed), tenant isolation, IDOR (the shopper
page is scoped by `userId` + `tenantId` via `getOrderForUser`, the admin page by
`requireAdminContext`), XSS (the shipping email is fully `escapeHtml`'d and the tracking
href is gated to http(s); React's own auto-escaping covers the UI; no
`dangerouslySetInnerHTML` anywhere in the new code), `PRINTFUL_API_KEY` handling
(server-only, never logged), input validation, and SSRF (the Printful client only ever
builds a path-and-`encodeURIComponent` URL against a hardcoded base). Unlike M3, no
security fix was needed this milestone. The `reviewer` agent's structural pass found the
milestone **ship-ready — no blockers.** Core state machine, poll ordering (both invariants
hold across every writer), guarded transitions, money threading, layering, and all six
migrations verified correct.

Two non-blocking follow-ups were filed rather than fixed in M4 (both currently open, not
tagged to a milestone):

- `#179` — MEDIUM. A stranded-`SUBMITTING` order is the one never-resolving mode with **no
  proactive alert**: a transient (non-`FulfillmentError`) failure after the
  `claimForSubmission` flip, or a worker killed before `markSubmitted`, leaves the order
  `SUBMITTING` forever. The retry's `claimForSubmission` returns `false` (the guard
  correctly refuses to re-submit), `runSubmission` returns without throwing, the outbox
  message settles `SENT` (no dead-letter, no `reportError`), and `findSubmittedForPolling`
  scans `SUBMITTED` only, so the order is never polled either. This is documented-by-design
  (`fulfillment.service.ts:210-212`) and idempotent — no double submission, no corruption —
  the finding is purely the _asymmetry_ against every sibling failure mode (#151/#155/#163),
  each of which does alert. A related nit folded into the same issue: `pollOne`'s
  null-`fulfillmentExternalId` branch (`fulfillment.service.ts:350-356`) returns `"errored"`
  without calling `recordPollError`, so that specific anomaly never joins the erroring
  streak/alert either.
- `#180` — LOW. The Stripe webhook's inline `dispatchForOrder` (`webhooks/stripe/route.ts:87`)
  now drains every due message for the order — including, once #139 landed, the Printful
  `createOrder` call (bounded at 15s, `printful.ts:45`) — synchronously before the webhook's 200. That reintroduces a blocking network call on the webhook response path, which the M2
  outbox decision exists specifically to avoid, and contradicts `printful.ts:40-43`'s own
  doc comment ("Submission runs in the background outbox drain, never a user request path").
  Practically: it can push the webhook past Stripe's response window (Stripe retries
  idempotently, so not data-unsafe) or be killed mid-`createOrder` (which trips #179 above).
  Latency/reliability, not correctness.
- A pre-existing nit, inherited rather than new: `env.ts`'s `Number()` coercion for
  `FULFILLMENT_STUCK_THRESHOLD_DAYS` / `FULFILLMENT_ERROR_ALERT_THRESHOLD` accepts
  oddities like `"1e3"` or `"0x10"` (from #162/#172); a malformed non-numeric value still
  fails fast at boot. Not filed as its own issue — cosmetic, and the fail-fast/fail-open
  split is the deliberate part.

## How to run & verify

```bash
docker compose up -d                 # Postgres on host port 55432
pnpm install
cp .env.example .env                 # then fill in the values below
pnpm db:migrate
pnpm db:seed
pnpm dev                             # http://localhost:3000
```

`PRINTFUL_API_KEY` is optional and unset by default — local dev and CI run entirely against
the deterministic `MockProvider`, no Printful account needed. To exercise the real adapter,
follow `docs/milestones/M4-fulfillment/printful-setup.md` (one-time operator setup: create a
Printful store, generate a Store-level Private Token, set `PRINTFUL_API_KEY`; the doc's
smoke test uses a free `confirm=0` draft, no charge). `FULFILLMENT_STUCK_THRESHOLD_DAYS`
(default 10) and `FULFILLMENT_ERROR_ALERT_THRESHOLD` (default 144) are also optional —
leave both unset for the documented defaults.

```bash
pnpm test                            # unit + dom — no infra, seconds
pnpm db:check-migrations             # static migration-safety guard, no DB needed
pnpm test:integration                # needs `docker compose up -d` (Postgres on 55432)

pnpm build && pnpm test:e2e          # Playwright boots `pnpm start` itself
```

**Happy path** — M1–M3's flows (browse → cart → checkout → PAID; subdomains; onboarding;
shopper accounts; search; analytics) are unchanged; see their handoffs. On top of it:

1. Check out at `demo.localhost:3000` with a US shipping address. On the success page, the
   order is PENDING → PAID (Stripe test card `4242 4242 4242 4242`).
2. Locally, trigger fulfillment submission by hand (production dispatches it automatically
   from the webhook): `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/dispatch-outbox`.
   The order moves to `SUBMITTED` against the mock provider (visible on the admin order
   detail as "Provider order ID: mock_<orderId>").
3. Poll for shipment: `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/poll-fulfillment`.
   The mock provider ships on the second poll — run it twice (or wait, if the GitHub Actions
   cron is live) — and the order flips to FULFILLED with a fake carrier/tracking number.
4. Visit the admin order detail (`/admin/<slug>/orders/<id>`) — shipping address, provider
   order id, carrier, and a clickable tracking link all render; "Mark fulfilled" is gone
   (superseded by the real transition) except as an override on a still-PAID order.
5. Sign in as the shopper who placed the order and visit `/account/orders/<id>` — the same
   shipment info renders in shopper-friendly language, no internal state names.
6. Check the inbox (or Resend dashboard, if configured) for the shipping-confirmation email
   with the tracking link.
7. To see the stuck/erroring admin banners without waiting on a real threshold, give a
   `SUBMITTED` order a `fulfillmentExternalId` containing `ONHOLD` or `GETTRACKING_ERROR`
   (see `mock.ts`'s marker constants) and poll repeatedly — the pattern the integration
   tests use.

## Inherited by next milestone

Real fulfillment is now live (mock + Printful, poll-based tracking, outbox submission,
shipping email, tracking surfaced admin + shopper). Any future provider-facing surface
should follow the `FulfillmentProvider` seam — implement the interface, select it in
`index.ts`, never touch checkout/order code. Seams left open on purpose:

- **Push-based (webhook) tracking** — still poll-only; revisit once Printful's v1/v2
  webhook-signing story is confirmed.
- **International addresses** — still a US-only allowlist (`SHIPPING_COUNTRIES`); a
  documented, easy fast-follow once per-country address rules are verified.
- **Stripe Connect / per-store payouts** — still deferred; a per-tenant payout model
  reshapes the payment layer enough to deserve its own milestone.
- **Partial shipments, returns/RMA, multi-warehouse, customs/duties, real-time carrier rate
  shopping** — all out of scope this milestone.
- **Address book / saved addresses** — an optional fast-follow; the flattened order
  snapshot doesn't foreclose it.
- **Two new deferred follow-ups**: `#179` (no proactive alert for a stranded-`SUBMITTING`
  order) and `#180` (the Stripe webhook's inline dispatch now includes a blocking Printful
  call) — see Known issues above.
- The **operator prerequisite** — a Printful store + Private Token, and the `confirm:false`
  draft smoke test — is documented in `docs/milestones/M4-fulfillment/printful-setup.md`;
  nothing in the app provisions a Printful account itself, matching M3's wildcard-domain
  hosting precedent.

## Links

- Release: **`vM4`** — pending (release PR `development` → `main` + tag cut at handoff).
- Milestone: GitHub Milestone "M4 — fulfillment" (#4) — 21/21 closed, 0 open.
- Review: `security-review` skill — clean, no findings. `reviewer` agent structural pass —
  ship-ready, no blockers; two non-blocking follow-ups filed (#179, #180) — see Known issues
  above.
- Merged PRs: #143 (docs: M4 seed), #144 (closes #134), #145 (closes #135), #146 (closes
  #136), #147 (closes #137), #149 (closes #138), #150 (closes #139), #152 (closes #140),
  #153 (closes #141), #154 (closes #151), #156 (closes #148), #159 (closes #155), #160
  (closes #157), #165 (closes #158), #166 (closes #142), #167 (closes #161), #168 (closes
  #162), #169 (closes #163), #173 (closes #164), #174 (closes #170), #176 (closes #171),
  #177 (closes #172), #178 (closes #175).
- Closed issues (21, milestone-tagged): #134, #135, #136, #137, #138, #139, #140, #141,
  #142, #148, #151, #155, #158, #161, #162, #163, #164, #170, #171, #172, #175. Also closed
  but not milestone-tagged: #157 (folded into PR #160).
- Changeset: `vM3..development` — 47 commits, 58 files, +9,785 / −261
  (`git diff vM3..development --shortstat`).
- Follow-ups filed at handoff, deferred rather than fixed: #179, #180.
