# Research — M4 Fulfillment

> Produced at milestone start (by the `researcher` agent). Read before building.

## Context & goal

`docs/milestones/M4-fulfillment/GOAL.md` (still a stub) sets the direction: turn the
platform's **manual** "Mark fulfilled" attestation into **real** fulfillment. Today
(`src/server/repositories/order.repository.ts:686-717`, `markFulfilled`) an admin clicks a
button and the order flips `PAID → FULFILLED` with no shipping address, no provider, no
tracking — a pure status attestation (`src/app/(admin)/admin/[storeSlug]/orders/order-actions.tsx:86-114`,
copy: "no carrier or provider is contacted"). M4 must make that transition real: collect a
shipping address at checkout, submit the paid order to a print-on-demand provider (sandbox),
and surface the resulting shipment/tracking on both the shopper's `/account/orders` detail and
the admin order detail, via a shipping-confirmation email through the existing outbox.
Tenant-isolated, layered (UI/route to service to repository to Prisma), money stays integer
cents. Provider config is per-platform (one upstream account for the whole app), not
per-store — per-store payouts need Stripe Connect, explicitly deferred
(`docs/ARCHITECTURE.md:35`, `:389-391`).

The seam is already drawn: `src/server/fulfillment/provider.ts` defines a
`FulfillmentProvider` interface; `src/server/fulfillment/printful.ts` is a stub that throws.
`docs/ARCHITECTURE.md` section 6 (`:84-89`) already commits to Printful/POD ("real API, faster
shipping, less payment-processor risk") over classic AliExpress dropshipping.

## Key questions

- Printful vs Printify vs mock-only — which provider, and how does its catalog/variant model
  map onto our arbitrary `ProductVariant.sku`?
- Webhook or poll for shipment/tracking back-flow, and how does it mirror the Stripe refund
  webhook's idempotent atomic reconciliation?
- Where does the shipping address live in the schema, and where in checkout is it collected?
- Where is provider submission triggered, how does it stay idempotent, and what does
  `FULFILLED` mean now?
- What's new in `env.ts`, and how do local dev/CI keep working without a real key?
- How is this tested (unit, integration, E2E) without hitting a real provider in CI?

## Findings

### Framework / APIs

**Next 16** (`package.json:37`, `next@16.3.3`) — nothing new is required beyond what the repo
already does:

- **Server Actions.** `node_modules/next/dist/docs/01-app/02-guides/server-actions.md:87-93`
  is explicit: "Render-time gating... is not a security boundary... Authenticate and
  authorize [and] validate inputs" inside every action. The repo already follows this
  (`checkout/actions.ts:35-51` re-derives tenant + session server-side, never trusts the
  client for anything except email). The new shipping-address step is just more fields on the
  same pattern — no new Next API needed. The doc also confirms Server Actions are
  single-roundtrip and sequential per client (`server-actions.md:26-32`), consistent with the
  two-phase `CheckoutForm` (`checkout-form.tsx:42-157`) already in place.
- **Route handlers / `runtime`.** Freshly re-verified:
  `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/runtime.md:18-23`
  — `'nodejs'` is the default, `'edge'` is deprecated, "Remove the `runtime` export from your
  route files." The three existing route handlers (`api/webhooks/stripe/route.ts:26-29`,
  `api/cron/sweep-orders/route.ts:18-20`, `api/cron/dispatch-outbox/route.ts:17-19`) all
  correctly omit `runtime`. Any new route (a poll cron; see below) should do the same.
- **`dynamic` / caching.** No new page needs a new `dynamic` export:
  `checkout/page.tsx:20` is already `force-dynamic` (reads the tenant + cart cookie);
  `account/orders/[id]/page.tsx:28` is already `force-dynamic` for the same reason a
  streamed/Suspense boundary would turn `notFound()` into a soft-404. The admin order detail
  page (`admin/[storeSlug]/orders/[id]/page.tsx`) has no `dynamic` export of its own, but
  **is** dynamic transitively: `[storeSlug]/layout.tsx:21` calls
  `requireAdminContext(storeSlug)`, which calls `headers()` at
  `src/server/auth/admin-context.ts:48` — verified by direct read, not assumed. Any new cron
  route follows the existing two-line recipe: `export const dynamic = "force-dynamic"` plus
  `export const maxDuration = 60` (`sweep-orders/route.ts:10,16`).

**Installed versions** (`package.json:28-47`): `next@16.3.3`, `stripe@^22.6.0`,
`@prisma/client@^6.19.3` / `prisma@^6.19.3`, `better-auth@^1.7.2`, `zod@^4.5.4`. Better Auth
is untouched by this milestone (no auth-model changes needed). Stripe's role stays
payment-only — see the address-collection recommendation below.

### Libraries / services

**Fulfillment provider — Printful v1 REST API, with a mock for everything else.**

I evaluated Printful, Printify, and a mock-only path against current (fetched) docs —
`https://developers.printful.com/docs/`, `https://developers.printful.com/docs/v2-beta/`,
`https://developers.printify.com/docs/` — since neither is in `node_modules` and my training
data is not authoritative here.

| | Printful v1 | Printful v2 (beta) | Printify |
|---|---|---|---|
| Auth | Private Token (store-scoped or account-level + `X-PF-Store-Id`) | same tokens as v1 | Personal Access Token, spans **all shops** in one account |
| Order create | `POST /orders`, one call with `confirm: true/false` | `POST /orders` (draft only) then a separate `POST /v2/orders/{id}/confirm`; confirm can fail while `costs.calculation_status` is pending | `POST /v1/shops/{shop_id}/orders.json` |
| Catalog mapping | `items[].variant_id` = a **global catalog** variant id (no per-store "sync product" step required) — or `sync_variant_id` if you do pre-sync | `items[].catalog_variant_id`, `source: "catalog"` — same flat model as v1's `variant_id` | 3-level: blueprint then print provider then variant; line items reference provider-specific variant ids |
| Sandbox | **None.** `confirm: false` creates a draft that "does not trigger production or billing" — the closest thing to a free sandbox | same draft mechanism | **None documented** |
| Webhooks | Event names incl. `package_shipped`, `order_failed`, `order_canceled`, `order_refunded`; **signature scheme not clearly documented for v1** | Documented HMAC-SHA256 signing: `x-pf-webhook-public-key` + `x-pf-webhook-signature` headers | Documented HMAC-SHA256: `X-Pfy-Signature: sha256={hex}` over the raw body — cleanly precedented, closest in shape to our own Stripe `constructEvent` verification |
| Rate limit | 120 req/min general | same | 600 req/min per integration, 100/min for catalog endpoints |
| Idempotency key | Not documented (only `external_id`, a free-form reference field) | not documented | not documented |

**Recommendation: Printful v1**, for four concrete reasons grounded in what's above:

1. It's the only option with a genuinely free, no-charge dry-run (`confirm: false`), which
   doubles as both a manual sandbox smoke test and the safe default for any accidental
   double-call (see Risks).
2. `items[].variant_id` is a **direct catalog reference** — we never need to "sync" a
   product into a Printful-hosted store catalog first (that's the `sync_variant_id` path,
   which we don't need). This keeps the adapter a thin HTTP client, not a second product
   catalog to keep in sync.
3. It's stable (not "-beta"), and a one-call `confirm: true` create matches our own
   "payment already captured, no review buffer needed" posture (Stripe already gated money
   safety; we don't need Printful's draft/confirm split for that purpose too).
4. It's what the repo already committed to: the stub file is literally named
   `src/server/fulfillment/printful.ts`, and `docs/ARCHITECTURE.md:87` says "starting with
   Printful."

**Printify stays the documented fallback** — same `FulfillmentProvider` interface, so
swapping is exactly the "suppliers are swappable" promise in `provider.ts:36-37` — if
Printful's account/store approval turns out to be a blocker, or if a future milestone wants
push-based (webhook) tracking, where Printify's `X-Pfy-Signature` scheme is the better-attested
one of the two.

Sources: [Printful API Documentation](https://developers.printful.com/docs/),
[Printful API v2 (beta)](https://developers.printful.com/docs/v2-beta/),
[Printify API Reference](https://developers.printify.com/docs/).

**Catalog/variant mapping (the critical design question).** Confirmed by reading
`src/lib/validators/catalog.ts:46-50` and `prisma/seed.ts:103-183`: `ProductVariant.sku` is a
**free-form, admin-typed string** ("TEE-S", "HOOD-M", "AUR-CNDL-...") with no relationship
whatsoever to any provider's catalog id (Printful catalog variant ids are opaque integers like
`4011` denoting one specific blank plus size plus color from one specific manufacturer). There
is no implicit mapping — it must be explicit and stored.

`CreateFulfillmentInput`'s `items: FulfillmentLineItem[]` (`provider.ts:1-4,16-20`) currently
carries only `{ sku, quantity }`. Two ways to close the gap:

- (a) Have `PrintfulProvider.createOrder` itself resolve `sku -> variant_id` via a repository
  read. Works, but blurs the provider adapter (meant to be a thin external-API client, the
  fulfillment analogue of `src/lib/stripe.ts`) into also being a data-access layer.
- (b) **Recommended:** add a nullable `providerVariantId String?` column to `ProductVariant`
  (provider-agnostic name, not `printfulVariantId` — keeps the interface swappable per its own
  doc comment), and widen `FulfillmentLineItem` with an optional `providerVariantId`. The
  **service** that orchestrates submission resolves the mapping (via the repository) and
  builds the enriched line item before calling `provider.createOrder`; the provider adapter
  stays a pure formatter/HTTP client. A variant with no mapping is a defined, admin-visible
  failure (see Risks), not a silent Printful 4xx.

This is a small, additive amendment to an interface the milestone brief calls "already
defined" — flagged explicitly rather than silently reinterpreted, since GOAL.md didn't
anticipate this gap.

**Response fields to persist**, from `POST /orders` / `GET /orders/{id}`: `id` (to
`fulfillmentExternalId`), `status` (free-form string from Printful: `draft`, `pending`,
`failed`, `canceled`, and in-flight values referenced across the docs as `inprocess`,
`onhold`, `partial`, `fulfilled`) — kept in a small **closed enum of our own** (see Schema
below) plus the raw string for display, and `shipments[]` (`tracking_number`, `tracking_url`,
`carrier`, `service`) which maps directly onto `TrackingInfo` (`provider.ts:27-32`).
`retail_price` is a **decimal string** (e.g. `"19.99"`) — confirms the money boundary rule
(golden rule 3): the adapter must format `(priceCents / 100).toFixed(2)` only at the HTTP
boundary, never store/compute with it internally.

**Unresolved from docs (flag, don't guess):** the exact required-vs-optional recipient fields
per country (does every country need `state_code`/`zip`? is `phone`/`email` required?) were
not resolvable from the fetched (JS-rendered/paginated) docs. Mitigated by starting with a
narrow country allowlist (below) rather than building generic international address
validation — verify the exact shape against the live OpenAPI spec at build time for whichever
countries are allow-listed.

### Patterns to follow

**Idempotent, atomic reconciliation — mirror the Stripe refund webhook exactly.** The pattern
to copy is `orderRepository.markRefundedByPaymentIntent`
(`order.repository.ts:741-762`): a single guarded `updateMany` with the *source* status in the
`WHERE` (`status: { in: ["PAID", "FULFILLED"] }`) is the one-way-door idempotency point — of N
racing callers, exactly one gets `count: 1`; everyone else (a duplicate delivery, a retry, a
concurrent cron run) gets `count: 0` and is a safe no-op. The same shape drives
`markPaidByPaymentIntent`'s `status: "PENDING"` guard (`order.repository.ts:442-445`) and
`markFulfilled`'s `status: "PAID"` guard (`order.repository.ts:704-707`). M4's own reconcile
(provider says "shipped" then flip `PAID -> FULFILLED` plus write tracking) is structurally the
same transition and must use the same guarded-`updateMany` idiom.

**Webhook vs poll — poll, and the interface itself is the tell.** `provider.ts:42` declares
`getTracking(externalId: string): Promise<TrackingInfo>` — a **pull**-shaped method. There is
no `parseWebhookEvent`/`verifyWebhook` counterpart anywhere in the interface. That, plus two
external findings, points at polling:

1. Printful v1's webhook **signature verification is not clearly documented** (only v2's
   `x-pf-webhook-public-key`/`x-pf-webhook-signature` HMAC-SHA256 scheme is well-attested, and
   it's unconfirmed whether it applies to v1-created orders) — exposing an unauthenticated or
   unclearly-authenticated public endpoint is a real security gap not worth papering over.
2. The repo already has **two** precedents for exactly this shape of background
   reconciliation — `sweep-orders` (`src/app/api/cron/sweep-orders/route.ts`) and
   `dispatch-outbox` (`src/app/api/cron/dispatch-outbox/route.ts`) — both authenticated via
   `verifyCronRequest` (`src/server/cron/verify-cron-request.ts:43-58`, a `timingSafeEqual`
   bearer-token check), both batch- and time-bounded, both registered in
   `.github/workflows/cron.yml:46` (the `for path in dispatch-outbox sweep-orders` loop) and
   `vercel.json:3-6`. A third cron, `poll-fulfillment`, is a straight copy of this
   established, already-tested house style — not a new pattern.

A future push-based fast-follow (lower tracking latency) is a legitimate later upgrade, once
the v1/v2 webhook-signing story is confirmed — not required for this milestone's exit
criteria.

**Reuse the transactional outbox for provider *submission*, not just email.** This is the
strongest structural finding of this research. `outboxService.dispatchOne`
(`outbox.service.ts:183-214`) already implements exactly the primitive M4 needs for
"submit a PAID order to an external system, at-least-once, with retry/backoff/dead-letter,
without double-sending": an atomic claim (`outbox.repository.ts:101-107`, the same
guarded-`updateMany` idiom as above), exponential backoff
(`outbox.service.ts:64-65,73-75`), permanent-vs-transient failure classification
(`outbox.service.ts:140-143`, already special-cases `EmailNotConfiguredError` — a
`FulfillmentNotConfiguredError`/`FulfillmentNotMappedError` slots into the exact same
`permanent` branch), stale-claim recovery for a killed worker
(`outbox.repository.ts:56-62`), and a type-dispatched `sendMessage` switch
(`outbox.service.ts:115-128`) that already throws a compile error (`message.type` narrows to
`never`) if a new `OutboxMessageType` value is added without a matching `case` — so the
mechanism is safe by construction against a forgotten branch. Concretely:

- Add `OutboxMessageType.FULFILLMENT_SUBMISSION` (and, for the email — see below,
  `SHIPPING_CONFIRMATION`) to the enum at `prisma/schema.prisma:305-307`.
- Enqueue it in the **same transaction** as the PENDING to PAID flip
  (`order.repository.ts:460-467`, right next to where `ORDER_CONFIRMATION` is enqueued today)
  — but only when the order carries a shipping address, so an order that somehow lacks one
  (a data anomaly, or a pre-M4 order) never silently attempts submission.
- `sendMessage`'s switch gets a new case calling a new `fulfillmentService.submitOrder(...)`.

This means **no bespoke claim/backoff/dead-letter machinery needs inventing** for
submission — only a small, well-justified extra guard layered on top (next section), because
this side effect is materially riskier than an email.

### Schema & state model (concrete proposal)

All new columns are **nullable** or carry a `DEFAULT`, satisfying golden rule 6 /
`docs/DATABASE.md:12-16` (a `NOT NULL` add on a possibly-non-empty table needs a `DEFAULT`) —
every existing `PAID`/`FULFILLED` row backfills safely with no data.

```prisma
// Order -- add (all nullable; an existing/guest/legacy order simply has none):
shipName        String?
shipLine1       String?
shipLine2       String?
shipCity        String?
shipState       String?
shipPostalCode  String?
shipCountry     String?   // ISO-3166 alpha-2, from the allowlist below

fulfillmentProvider    String?           // "printful" | "mock" -- future-proofs a provider swap
fulfillmentExternalId  String?           // provider's order id (FulfillmentResult.externalId)
fulfillmentStatus      FulfillmentStatus @default(NOT_SUBMITTED)
fulfillmentProviderStatus String?        // raw provider status string, admin display only
trackingCarrier   String?
trackingNumber    String?
trackingUrl       String?

enum FulfillmentStatus {
  NOT_SUBMITTED  // PAID, no address yet or not yet picked up by the outbox
  SUBMITTING     // claimed for submission -- the idempotency guard (see below)
  SUBMITTED      // provider accepted the order; no tracking yet
  SHIPPED        // provider reports shipped -- flips Order.status to FULFILLED
  FAILED         // provider rejected it (soft failure) or attempts exhausted
}

// ProductVariant -- add:
providerVariantId String?   // maps our sku to the provider's catalog variant id

// OutboxMessageType -- extend:
enum OutboxMessageType {
  ORDER_CONFIRMATION
  FULFILLMENT_SUBMISSION
  SHIPPING_CONFIRMATION
}
```

Address fields are **flattened onto `Order`**, not a separate `Address` model, for two
reasons grounded in the existing code, not preference: (1) it matches the codebase's
established snapshot philosophy — `OrderItem.titleSnapshot`/`priceCents`
(`schema.prisma:276-279`) exist precisely so later catalog edits never rewrite order history;
an address is the same kind of point-in-time fact, and a future reusable address-book
(explicitly deferred in `GOAL.md:38`) would still need its own order-level snapshot copy, so
starting flattened doesn't foreclose it — it's additive later, not a rework. (2) it avoids a
join on every place an order is already read whole:
`order.repository.ts:293-298` (`findByIdForTenant`, used by both the admin detail page and
`outbox.service.ts:105-108`'s email re-read), `:312-317` (the shopper-scoped read), and the
new fulfillment-outbox re-read all get the address "for free" on the same row.

**What `FULFILLED` means now.** Redefined (a documentation/behavior change, not an enum-value
migration) from "an admin attested this shipped" to **"the provider confirms it shipped"** —
driven exclusively by the poll cron's guarded `PAID -> FULFILLED` transition, mirroring how
`REFUNDED` is driven exclusively by the verified webhook
(`order.service.ts:848-850`: "Makes NO database write: the verified webhook is the SOLE
writer of REFUNDED"). The existing manual "Mark fulfilled" button
(`order-actions.tsx:86-114`, `orders/actions.ts:75-89`) **stays** as a documented
manual-override escape hatch (non-POD items, a provider outage, an unmapped SKU) — its copy
should change from "no carrier or provider is contacted" to something clarifying it's a manual
override now that automatic fulfillment exists.

**Idempotent submission — two layers, because this is money plus a physical shipment, not an
email.** The outbox's own claim (layer 1) is exactly what protects email today, but the outbox
doc itself names the residual gap: "the sole remaining window (a send that succeeds but whose
row update is then lost to a killed worker)" (`outbox.service.ts:29-31`) — for email, Resend's
own idempotency key closes that window; **Printful has no documented idempotency-key API**, so
nothing closes it on the provider side. Because a duplicate Printful order means a real second
garment printed and shipped (not a harmless duplicate email), add a second, order-level guard:
`fulfillmentService.submitOrder` first does a guarded `updateMany`
(`fulfillmentStatus: "NOT_SUBMITTED" -> "SUBMITTING"`, same one-shot idiom as
`markFulfilled`) before calling `provider.createOrder`; only the winner proceeds. On success,
a second guarded write (`"SUBMITTING" -> "SUBMITTED"`, guard on still being `"SUBMITTING"`)
persists `fulfillmentExternalId`. If the process dies between the provider call succeeding and
that write landing, the order is left stuck in `SUBMITTING` — deliberately **not**
auto-retried (that would risk a second real order) — surfaced to the admin as a "needs
attention" state to reconcile by hand against the Printful dashboard. This trades
at-least-once for at-most-once-with-a-manual-unstick specifically for this side effect, which
is the right trade for its cost profile. Also pass Printful's `external_id` = our `Order.id` on
every create call — not confirmed to dedupe server-side, but makes any accidental duplicate
immediately greppable in the Printful dashboard.

One more concrete implementation note: `FulfillmentResult.status: "submitted" | "failed"`
(`provider.ts:22-25`) already normalizes a **soft rejection** (e.g. an invalid address) into a
*resolved* value, not a thrown error. `sendMessage`'s new case should treat
`result.status === "failed"` by persisting `FulfillmentStatus.FAILED` directly and returning
normally (not throwing) — retrying an address Printful already rejected would just burn
attempts for nothing; that's what the `permanent` branch of `settleFailure`
(`outbox.service.ts:140-143`) is for, and this is the same shape as
`EmailNotConfiguredError`'s handling.

### Checkout — where the address is collected

Collected in the **existing phase-1** of `CheckoutForm` (`checkout-form.tsx:42-157`,
currently email-only), not a new page/step: extend `checkoutInputSchema`
(`src/lib/validators/checkout.ts:10-13`) with the address shape, extend
`startCheckoutAction` (`checkout/actions.ts:21-79`) to pass it through to
`orderService.startCheckout` (`order.service.ts:542-619`), and write it in the **same**
transaction as order creation (`orderRepository.createWithItems`,
`order.repository.ts:214-270`) — no separate write, no extra round trip.

**Stripe collects no address** — confirmed by reading `order.service.ts:565-577`: the
PaymentIntent today is created with only `amount`, `currency`, `metadata`, `receipt_email`,
`automatic_payment_methods: { enabled: true }`. Recommend leaving it exactly that way: our own
form is the single source of shipping data, decoupled from whatever address UI a given payment
method's Stripe Element might optionally surface (which returns a different field shape than
our `ShippingAddress` interface, and would need to be reconciled with what the shopper typed —
one source is simpler and matches `docs/ARCHITECTURE.md`'s existing "we own checkout, not a
Stripe-hosted flow" posture, `:107-109`).

**Validation: zod shape plus a small country allowlist**, not the provider's live address
endpoint. Recommend a `SHIPPING_COUNTRIES` closed list mirroring the existing `CURRENCIES`
pattern exactly (`src/lib/validators/catalog.ts:22-25` — `["usd","eur","gbp"] as const` plus
`z.enum`), starting narrow (e.g. `US` only, or `US` plus a couple of confirmed-simple shapes)
and documented as an easy fast-follow to extend. Calling Printful's cost/estimate endpoint
synchronously inside checkout would add a third-party network round trip (latency plus a new
failure mode) to the money-critical path the codebase otherwise keeps lean (the Stripe webhook
itself deliberately avoids blocking calls on its response path — see the outbox's "never a
blocking network call" note, `docs/ARCHITECTURE.md:126-128`). This also sidesteps the
unresolved "which fields are required per country" gap noted above — a narrow allowlist means
we only need to get the shape right for a few countries, verified against the live Printful
spec at build time.

### Config & secrets

Follow the **optional, validated-at-send-time** pattern already used for `RESEND_API_KEY`
(`env.ts:36`, via `optionalEnvString`, `env.ts:13-16`), not the required-at-boot pattern used
for `STRIPE_SECRET_KEY`. Reasoning, directly from the existing comment
(`env.ts:28-35`): fulfillment submission is a best-effort background job (via the outbox),
exactly like the confirmation email — a missing key must not take down checkout/storefront
boot, only cause submission messages to hit a `FulfillmentNotConfiguredError` then `DEAD`, the
same handling `EmailNotConfiguredError` already gets (`outbox.service.ts:141,151-153`).
Concretely: `PRINTFUL_API_KEY: optionalEnvString` in the schema (`env.ts:18-48`). This also
directly answers "how local dev/build still work without a real key" — identically to how
Resend already works today (no dummy-secret injection required beyond what local builds
already need for the *required* Stripe/Better Auth keys). Never `NEXT_PUBLIC_*`; read only
inside `src/server/fulfillment/**`.

### Testing

- **Mock provider.** `src/server/fulfillment/mock.ts` implementing `FulfillmentProvider`
  deterministically (in-memory, canned "submitted" then "shipped" progression) — this is
  explicitly anticipated by the interface's own doc comment: "swap Printful for Printify, a
  real supplier, or a mock without touching order or checkout code" (`provider.ts:36-37`).
  Used by unit tests, integration tests, and as the default in CI/dev (no key needed, since
  `PRINTFUL_API_KEY` is optional per above).
- **Unit tests** for the new `fulfillmentService`, mocking at the same seam
  `order.service.test.ts` already establishes for `getStripe`
  (`vi.mock("@/lib/stripe", () => ({ getStripe: vi.fn() }))`,
  `order.service.test.ts:28,162` — per the repo's own "constructor needs a class" mocking
  convention for a `new`-ed external client).
- **Integration tests** (`*.integration.test.ts`, real Postgres, the existing
  `pnpm test:integration` harness) for the new guarded writes — the `SUBMITTING` claim and the
  poll cron's `PAID -> FULFILLED` reconciliation — mirroring the existing coverage style of
  `markPaidByPaymentIntent`/`markRefundedByPaymentIntent` in
  `order.repository.integration.test.ts`.
- **Playwright E2E.** Extend `e2e/checkout.spec.ts`'s existing real-Stripe-test-mode flow
  (`checkout.spec.ts:50-166`, already drives the full embedded Payment Element) with the new
  address fields, asserting the address round-trips into the order row.
- **Real sandbox smoke test.** Feasible, but **manual only** — a human-run `confirm: false`
  draft order against a developer's own Printful account (free, no production, no charge).
  Not automatable in CI: Printful has no isolated/shared sandbox environment (confirmed by
  research above), so CI stays on the mock exclusively.

### Emails

New `OutboxMessageType.SHIPPING_CONFIRMATION`, rendered by a new
`emailService.sendShippingConfirmation` alongside the existing
`renderOrderConfirmation` (`email.service.ts:120-220`, same escaped-HTML-table plus
plain-text-alternative shape). Enqueued in the **same transaction** as the poll cron's
`PAID -> FULFILLED` plus tracking-field write — identical reasoning to the existing decision
log entry for `ORDER_CONFIRMATION` (`docs/ARCHITECTURE.md:124-128`: "a paid order can never
exist without its confirmation being queued") — here, a shipped order can never exist without
its shipping email being queued. Sent by the same drain (`/api/cron/dispatch-outbox`), no new
send path.

## Risks & unknowns

- **Printful v1 webhook signature verification is not clearly documented** (only v2's
  `x-pf-webhook-public-key`/`x-pf-webhook-signature` HMAC-SHA256 scheme is well-attested, and
  it's unconfirmed whether it covers v1-created orders) → **mitigation:** don't build a
  webhook receiver this milestone; poll instead (see Findings). Revisit if a future milestone
  wants push-based tracking, confirming the v1/v2 story first.
- **No confirmed provider-side idempotency-key on order creation** → a crash between a
  successful `provider.createOrder` call and persisting `fulfillmentExternalId` could
  theoretically double-submit → **mitigation:** the two-layer guard above
  (outbox claim plus an order-level `SUBMITTING` state that fails toward "stuck, needs a
  human" rather than "silently retry"), plus `external_id` traceability in the Printful
  dashboard.
- **Per-country address-field requirements are genuinely complex** (state/zip requirements
  vary; exact required/optional fields weren't resolvable from the fetched docs) →
  **mitigation:** ship a narrow `SHIPPING_COUNTRIES` allowlist (e.g. US-only) rather than
  generic international validation; verify the exact per-country shape against the live
  OpenAPI spec before adding a country. Document as a fast-follow to extend.
- **A confirmed (non-draft) Printful order is real money and a real shipped good** — the
  platform's Printful account needs a funded payment method in production →
  **mitigation:** CI/tests never touch the real provider (mock only); any real-provider
  verification stays a manual, `confirm: false` draft (free) run by a human.
  Store/token setup itself is an **operator prerequisite** (create the one platform Printful
  store, generate its Private Token) — not something the app provisions, the same category as
  M3's wildcard-domain-hosting prerequisite (`docs/milestones/M3-platform/research.md`
  precedent) — document in the M4 handoff, not a blocker to building.
- **The `FulfillmentProvider` interface needs a small, additive amendment**
  (`FulfillmentLineItem` gains an optional `providerVariantId`) even though GOAL.md describes
  it as "already defined" → flagged explicitly here so the builder treats it as an
  intentional, evidence-based amendment (the mapping gap is real — see Findings — not a
  reinterpretation of settled design).
- **Reusing the outbox's tuning constants (`MAX_SEND_ATTEMPTS`, backoff curve,
  `outbox.service.ts:53,64-65`) across two very different side effects** (an email vs. a paid
  external order) is a shared, module-global knob today → acceptable to start (both are
  reasonable defaults), but if real-world tuning needs diverge, generalize `backoffMs`/
  `MAX_SEND_ATTEMPTS` to vary by `OutboxMessageType` as a small follow-up rather than
  over-engineering it now.
- **`node_modules/next/dist/docs` and the installed `stripe`/`prisma` versions confirm no
  contradictions** with this plan — nothing here relies on a deprecated Next 16 API, and no
  Stripe/Prisma feature is assumed beyond what the repo already uses (Stripe stays
  payment-only; Prisma gets only additive, nullable/`DEFAULT`-safe columns).

## Recommended approach

Build bottom-up, schema first, then the two independent collection paths (checkout address,
admin catalog mapping), then the mock provider plus service skeleton (so everything above the
provider boundary can be built and tested before touching real Printful), then the real
adapter, then wire submission through the outbox, then reconciliation via a new poll cron, then
the email, then surface it all in the UI. This sequencing means CI is green and the milestone
is testable end-to-end (against the mock) well before the real Printful adapter lands, and the
real-provider work is isolated to one task with a narrow, well-defined interface to implement
against.

The two riskiest/least-certain pieces — the exact per-country address shape Printful expects,
and the provider's exact status vocabulary/timing for "shipped" — should be verified against
the live API (not just docs) as part of building tasks 5 and 7 below, since the fetched docs
left both only partially specified.

## Suggested task breakdown

Five to nine small, one-PR-each, dependency-ordered issues:

1. **Schema migration** — `Order` shipping-address plus fulfillment-tracking columns,
   `FulfillmentStatus` enum, `ProductVariant.providerVariantId`, extend
   `OutboxMessageType` with `FULFILLMENT_SUBMISSION` plus `SHIPPING_CONFIRMATION`. Pure
   Prisma/migration plus `pnpm db:check-migrations`; no application code. *(Foundation —
   everything else depends on this.)*
2. **Shipping-address checkout step** — extend `checkoutInputSchema` plus a
   `SHIPPING_COUNTRIES` allowlist, extend `CheckoutForm`/`startCheckoutAction`/
   `orderService.startCheckout`/`orderRepository.createWithItems` to collect and persist the
   address; unit plus Playwright coverage. *(Depends on #1.)*
3. **Admin catalog-mapping field** — add `providerVariantId` to the product/variant admin
   form, validators, and repository write path. *(Depends on #1; independent of #2 —
   parallelizable.)*
4. **Mock fulfillment provider plus `fulfillmentService` skeleton** —
   `src/server/fulfillment/mock.ts`, a new `fulfillmentService` that resolves the
   variant-to-provider mapping via the repository, builds `CreateFulfillmentInput`, and calls
   an injected `FulfillmentProvider`; unit-tested entirely against the mock. No real Printful
   yet. *(Depends on #1, #3.)*
5. **Printful provider adapter** — implement `PrintfulProvider.createOrder`/`getTracking`
   against the real v1 API; `PRINTFUL_API_KEY` added to `env.ts` (optional, per the Resend
   pattern); verify the exact recipient-field/status vocabulary against the live spec;
   document the manual `confirm:false` smoke test. *(Depends on #4's interface shape.)*
6. **Submission wiring via the outbox** — enqueue `FULFILLMENT_SUBMISSION` in the PAID
   transaction (only when an address is present); `outbox.service.ts`'s `sendMessage` gains
   the new case plus the `SUBMITTING` order-level guard; integration-tested. *(Depends on #4,
   #5.)*
7. **Poll-fulfillment cron plus reconciliation** — new `/api/cron/poll-fulfillment` route
   (mirrors `sweep-orders`/`dispatch-outbox`), a guarded `PAID -> FULFILLED` plus
   tracking-field write, registered in `.github/workflows/cron.yml` and `vercel.json`;
   integration-tested. *(Depends on #6.)*
8. **Shipping-confirmation email** — `emailService.sendShippingConfirmation` plus outbox
   wiring, enqueued by #7's reconciliation transaction. *(Depends on #7.)*
9. **Surface tracking in the UI** — admin order detail plus shopper `/account/orders/[id]`
   show the address, fulfillment status, and carrier/tracking link; update the manual "Mark
   fulfilled" button copy to read as a documented override now that automatic fulfillment
   exists. *(Depends on #1; best landed last so it can show real end-to-end data from #2-#8.)*

## References

- `src/server/fulfillment/provider.ts`, `src/server/fulfillment/printful.ts` — the seam this
  milestone fills.
- `src/server/services/order.service.ts`, `src/server/repositories/order.repository.ts` — the
  order state machine and its guarded-transition idiom to mirror.
- `src/server/services/outbox.service.ts`, `src/server/repositories/outbox.repository.ts` —
  the claim/backoff/dead-letter machinery recommended for reuse.
- `src/app/api/webhooks/stripe/route.ts` — the verified/idempotent webhook pattern (referenced
  for contrast; not reused directly since M4 recommends polling).
- `src/app/api/cron/sweep-orders/route.ts`, `src/app/api/cron/dispatch-outbox/route.ts`,
  `src/server/cron/verify-cron-request.ts` — the cron pattern the new poll route should copy.
- `prisma/schema.prisma`, `docs/DATABASE.md` — schema plus migration-safety rules applied
  above.
- `src/lib/env.ts`, `src/lib/stripe.ts` — the config/secret and lazy-singleton-client patterns.
- `docs/ARCHITECTURE.md` sections 5-8 — payments/fulfillment context and the decision log this
  milestone will extend.
- [Printful API Documentation](https://developers.printful.com/docs/) — v1 REST API
  (recommended provider).
- [Printful API v2 (beta)](https://developers.printful.com/docs/v2-beta/) — catalog-first
  model, documented webhook signing; reference for a future push-based fast-follow.
- [Printify API Reference](https://developers.printify.com/docs/) — documented fallback
  provider, notably better-attested webhook signing (`X-Pfy-Signature`).
- `node_modules/next/dist/docs/01-app/02-guides/server-actions.md`,
  `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/runtime.md`
  — Next 16 API surface consulted for this brief.
