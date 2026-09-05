# M4 — Fulfillment

Turn the platform's **manual** "Mark fulfilled" attestation into **real** fulfillment: a
shopper provides a shipping address at checkout, a PAID order is submitted to a
print-on-demand provider (sandbox/draft), and its shipment + tracking flow back to the
shopper's order history, the admin order detail, and a shipping-confirmation email. This is
the milestone that makes an order actually ship.

Scope was fixed at `/milestone-start` (this doc). Technical decisions — the provider choice,
the poll-vs-webhook call, the schema shape, submission via the outbox, and what `FULFILLED`
means now — are recorded in [`research.md`](research.md), produced alongside this file. The
M1/M2/M3 rules are non-negotiable: tenant-isolated, layered (UI/route → service → repository
→ Prisma), money stays integer **cents**, server-only stays server-only.

## Goal

A shopper checks out with a validated shipping address; once the Stripe webhook flips the
order to PAID, the order is submitted to the fulfillment provider (Printful, sandbox/draft)
at-least-once and idempotently; a background poll reconciles the provider's shipment status,
persists carrier + tracking, flips the order to FULFILLED, and queues a shipping email; and
both the admin order detail and the shopper's `/account/orders/[id]` show the address,
fulfillment status, and tracking. Everything stays tenant-isolated, layered, and money-safe.

## Key decisions (from research — see [`research.md`](research.md))

- **Provider: Printful v1 REST API + a deterministic mock.** Printful is the only option with
  a free no-charge dry-run (`confirm: false` draft), uses a flat `variant_id` catalog
  reference (no per-store product-sync step), is stable (not `-beta`), and is what the repo
  already committed to (`src/server/fulfillment/printful.ts`, `docs/ARCHITECTURE.md` §6). A
  mock provider is the **CI/test default** (no key needed); Printify is the documented
  fallback behind the same `FulfillmentProvider` interface.
- **Tracking is polled, not webhook-driven.** The interface is pull-shaped
  (`getTracking(externalId)`), Printful v1's webhook signature scheme is not clearly
  documented, and the repo already has two authenticated cron precedents (`sweep-orders`,
  `dispatch-outbox`). A new `/api/cron/poll-fulfillment` copies that house style. Push-based
  tracking is a deferred fast-follow.
- **Shipping address is flattened onto `Order`** (not a separate `Address` model) — matching
  the existing `OrderItem` snapshot philosophy and avoiding a join on every order read. All
  new columns are nullable / carry a `DEFAULT`, so existing PAID/FULFILLED rows backfill
  safely (golden rule 6).
- **Provider submission reuses the transactional outbox** — a new
  `OutboxMessageType.FULFILLMENT_SUBMISSION` enqueued in the same transaction as the
  PENDING → PAID flip, drained by the existing claim/backoff/dead-letter machinery. Layered
  with a **second, order-level `SUBMITTING` guard** (`FulfillmentStatus`), because a duplicate
  POD order is real money + a physical shipment, unlike a duplicate email: it fails toward
  "stuck, needs a human" rather than silently retrying.
- **`FULFILLED` is redefined** from "an admin attested this shipped" to **"the provider
  confirms it shipped"**, driven solely by the poll cron's guarded `PAID → FULFILLED`
  transition (mirroring how the verified webhook is the sole writer of `REFUNDED`). The manual
  "Mark fulfilled" button **stays** as a documented manual-override escape hatch (non-POD
  items, provider outage, an unmapped SKU); its copy is updated to say so.
- **`ProductVariant.providerVariantId`** (nullable, provider-agnostic) maps our free-form
  `sku` to the provider's catalog variant id; the submission **service** resolves it via the
  repository so the provider adapter stays a thin HTTP client. `FulfillmentLineItem` gains an
  optional `providerVariantId` (a small, deliberate additive amendment to the "already
  defined" interface — the mapping gap is real).
- **Config: `PRINTFUL_API_KEY` is optional** (the `RESEND_API_KEY` pattern — validated at
  send time, never at boot), never a `NEXT_PUBLIC_*`, read only inside
  `src/server/fulfillment/**`. Local dev/CI work with no key (mock default).

## In scope

**1. Shipping address**

- Collect + validate a shipping address in the existing checkout step (extend
  `checkoutInputSchema` and `CheckoutForm`, not a new page), against a narrow
  `SHIPPING_COUNTRIES` allowlist (start **US-only**, documented as an easy fast-follow to
  extend). Persist it flattened onto `Order` **in the same transaction** as order creation.
  Stripe stays payment-only (our form is the single source of shipping data).

**2. Provider abstraction + config**

- A deterministic **mock** `FulfillmentProvider` (`src/server/fulfillment/mock.ts`) — the
  CI/test default and dev fallback.
- The real **`PrintfulProvider`** adapter (`createOrder`/`getTracking`) against the v1 REST
  API, with `PRINTFUL_API_KEY` added to `env.ts` (optional). `retail_price` is a decimal
  string at the HTTP boundary only — cents stay the internal unit.
- **`providerVariantId`** on `ProductVariant`, settable in the admin product/variant form.

**3. Order → fulfillment lifecycle**

- Enqueue `FULFILLMENT_SUBMISSION` in the PAID transaction (only when the order has an
  address); `outboxService`'s `sendMessage` gains the case, calling a new
  `fulfillmentService.submitOrder` behind the **two-layer** idempotency guard. An unmapped
  variant, an unconfigured provider, or a soft rejection → `FAILED` (surfaced, never spins);
  if **any** line is unmapped the whole submission fails to `FAILED` (no partial shipment).
- A new **`/api/cron/poll-fulfillment`** route (mirroring `sweep-orders`/`dispatch-outbox`,
  registered in `.github/workflows/cron.yml` + `vercel.json`) reconciles provider status:
  persists carrier + tracking and flips `PAID → FULFILLED` via a guarded, idempotent
  transition, enqueuing the shipping email in the same transaction.

**4. Tracking surfaced**

- A **`SHIPPING_CONFIRMATION`** email (new `emailService.sendShippingConfirmation`) via the
  existing outbox drain — no new send path.
- The shipping address + fulfillment status + carrier/tracking link on **both** the admin
  order detail and the shopper `/account/orders/[id]`.

## Out of scope (deferred, by design)

- **Per-store payouts / Stripe Connect** — still deferred (reshapes the payment layer).
- **Push-based (webhook) tracking** — poll-only this milestone; revisit once the v1/v2
  webhook-signing story is confirmed.
- **Generic international address validation** — a narrow country allowlist only; per-country
  field rules verified against the live spec before adding a country.
- **Multi-warehouse, partial shipments, returns/RMA, real-time carrier rate shopping,
  customs/duties** — later.
- **Address book / saved addresses** for repeat shoppers — an optional fast-follow (the
  flattened order snapshot doesn't foreclose it).
- **Automatic restock / partial refund on a failed or cancelled fulfillment** — unchanged
  from M2/M3 (full-refund-only, manual restock).

## Exit criteria

_Finalized at `/milestone-start`; technical specifics live in [`research.md`](research.md).
Adjust only with a note here if building forces a change._

- [ ] **Shipping address at checkout** — a shopper supplies a shipping address in checkout;
      it's validated server-side (zod + the `SHIPPING_COUNTRIES` allowlist) and persisted on
      the `Order` in the same transaction as order creation; the Stripe PaymentIntent still
      collects no address. Guest and signed-in checkout both work.
- [ ] **Schema, migration-safe** — `Order` shipping + fulfillment/tracking columns, the
      `FulfillmentStatus` enum, `ProductVariant.providerVariantId`, and the two new
      `OutboxMessageType` values ship in one forward-only migration; every new `NOT NULL`
      column has a `DEFAULT` (or is nullable) and `pnpm db:check-migrations` passes.
- [ ] **Provider abstraction** — a deterministic mock and a real `PrintfulProvider` both
      implement `FulfillmentProvider`; `PRINTFUL_API_KEY` is optional (validated at use, not
      boot) and read only under `src/server/fulfillment/**`; the mock is the CI default so no
      real provider is ever called in CI.
- [ ] **Catalog mapping** — `providerVariantId` is settable per variant in the admin form and
      persisted (tenant-scoped); the submission service resolves `sku → providerVariantId` via
      the repository, keeping the adapter a thin HTTP client.
- [ ] **Idempotent submission** — a PAID order with an address is submitted to the provider
      at-least-once via the outbox; a duplicate/retry/racing drain **never** double-submits
      (outbox claim + order-level `SUBMITTING` guard); an unconfigured provider, an unmapped
      variant, or a soft rejection resolves to `FAILED` (surfaced, not retried forever); the
      provider's external id is persisted.
- [ ] **Reconciliation + `FULFILLED`** — `/api/cron/poll-fulfillment` reconciles provider
      status, persists carrier + tracking, and flips `PAID → FULFILLED` via a guarded,
      idempotent transition (mirroring the refund webhook); registered in
      `.github/workflows/cron.yml` + `vercel.json`. `FULFILLED` now means provider-confirmed
      shipped; the manual "Mark fulfilled" override stays, with updated copy.
- [ ] **Shipping email** — a `SHIPPING_CONFIRMATION` email is enqueued in the reconciliation
      transaction and delivered by the existing outbox drain (a shipped order can never exist
      without its shipping email queued).
- [ ] **Tracking surfaced** — the admin order detail and the shopper `/account/orders/[id]`
      both show the shipping address, fulfillment status, and carrier/tracking link;
      tenant/user scoping is unchanged (no Prisma in the pages).
- [ ] **Tenancy, layering, money** — every new read/write is tenant-scoped; pages/routes go
      through services; money stays integer cents (provider decimal strings only at the HTTP
      boundary).
- [ ] **Tests green in CI** — unit tests for `fulfillmentService` (against the mock),
      repository **integration** tests for the `SUBMITTING` claim and the poll reconciliation,
      and a Playwright **E2E** asserting the address round-trips through checkout into the
      order row; `verify` + `test-db` jobs green.
- [ ] **Quality gates** — `pnpm build`, `pnpm typecheck`, `pnpm lint`, and the full test
      suite green; CI passing on `development`.
- [ ] **Docs** — `research.md` (this milestone), the `docs/ARCHITECTURE.md` §6 + decision
      log, and `docs/DATABASE.md` (new columns/enums) updated; the Printful store/token
      **operator prerequisite** and the manual `confirm:false` smoke test documented;
      `handoff.md` at close.

## GitHub

- Milestone: **M4 — fulfillment** (#4).
- Issues labelled `phase:M4`, `type:*`, `area:fulfillment` (+ `area:db`/`area:ui`/`area:ops`
  as relevant); each ≈ one PR. Build order and dependencies are in the milestone description
  and in each issue.
