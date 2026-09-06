# Handoff — M1 Commerce slice

> Written at milestone close (by the `scribe` agent).

Turns the scaffold into a demoable store: a shopper browses the catalog and completes
a real Stripe test-mode purchase; an admin manages the catalog behind auth.

## Shipped

- **Auth + tenant context + `/admin` gate** (#9, PR #18) — `src/server/auth/admin-context.ts`
  (`requireAdminContext`: session → `Membership` lookup → `hasAtLeast(role, STAFF)`,
  `cache()`-memoised per request); `src/proxy.ts` (Next 16 renamed `middleware.ts` →
  `proxy.ts`; a cookie-only optimistic gate, no DB — the authoritative check stays in the
  admin layout); `src/server/repositories/{tenant,membership}.repository.ts`; sign-in/up
  pages under `src/app/(auth)/**`; seeded admin via Better Auth (`prisma/seed.ts`).
- **Admin catalog CRUD** (#10, PR #20) — `src/app/(admin)/admin/products/**` (list,
  `new/`, `[id]/`, shared `product-form.tsx`, `actions.ts` Server Actions);
  `src/server/services/catalog.service.ts`; `src/server/repositories/product.repository.ts`
  (tenant-scoped create/update/archive + variant reconcile). Products are archived
  (`ProductStatus.ARCHIVED`), never hard-deleted.
- **Storefront list + PDP, SSR + metadata** (#11, PR #21) — `src/app/(storefront)/products/**`;
  `src/server/store-context.ts` (`getStoreTenant`, `cache()`-memoised public tenant read);
  `generateMetadata` on the PDP; a missing/DRAFT/ARCHIVED slug is a real `notFound()` — the
  storefront never leaks hidden catalog.
- **Cookie-backed cart** (#12, PR #22) — `src/lib/cart.ts` (pure zod schema
  `{ variantId, qty }` + reducers `normalizeCart` / `setLineQty` / `removeLine`, qty
  clamped to `MAX_CART_QTY`); `src/server/cart-cookie.ts` (`httpOnly`, tolerant read — a
  missing/malformed/tampered cookie collapses to `[]`); `src/server/services/cart.service.ts`
  (reconciles every line against a live `ProductVariant` read — price/title/stock are never
  trusted from the cookie — priced in the store's single currency); `src/app/(storefront)/cart/**`.
- **Stripe checkout: PaymentIntent + Payment Element** (#13, PR #24) —
  `src/app/(storefront)/checkout/**`; `src/server/services/order.service.ts`
  (`startCheckout`: server-recomputes price via the cart service, creates the PaymentIntent
  with `metadata: { orderId, tenantId }`, writes a `PENDING` `Order` + snapshotted
  `OrderItem`s in one write, idempotency-keyed on the pre-generated order id). The success
  page verifies the URL's `payment_intent_client_secret` against the live PaymentIntent
  before showing any order detail (IDOR fix, commit `7f65b54`, folded into this PR).
- **Stripe webhook → idempotent PAID** (#14, PR #28) —
  `src/app/api/webhooks/stripe/route.ts` (verifies `stripe-signature` over the raw body;
  acts only on `payment_intent.succeeded`; tenant resolved from PI metadata, never
  guessed); `orderService.markOrderPaid` → `orderRepository.markPaidByPaymentIntent`
  (one transaction: an atomic status-guarded `updateMany({ status: "PENDING" })` is the
  idempotency point, then stock is decremented — see Key decisions).
- **Order confirmation email** (#15, PR #29) — `src/server/services/email.service.ts`
  (Resend; lazily-constructed client so a build never needs a real key; HTML-escaped
  order/product text; throws on a Resend `error` response so the caller has one failure
  channel). Sent from inside the webhook's single `PENDING` → `PAID` transition
  (`sendConfirmationEmailSafely` logs and swallows — a Resend outage must never turn a
  real payment into a retried webhook 500).
- **Design polish** (#16, PR #32) — `src/app/globals.css` (one OKLCH emerald
  `--primary`/`--ring`/`--accent` set, dark mode via `@media (prefers-color-scheme: dark)`
  — no manual toggle); home page + storefront/admin shells; lucide icons throughout.
- **Guard variant deletion** (#19, PR #33) — `VariantInUseError`
  (`src/server/catalog.errors.ts`) plus a pre-check inside `updateWithVariants`
  (`src/server/repositories/product.repository.ts:159-170`) that names the offending SKUs
  before the delete runs, with a `P2003` catch as a race backstop
  (`OrderItem.variant` is `onDelete: Restrict`).
- **Single currency per tenant** (#23, PR #36) — `Tenant.currency` added
  (`prisma/schema.prisma`, migration `20260901090000_single_currency_per_tenant`);
  `ProductVariant.currency` removed — variants inherit the store currency; `Order.currency`
  kept as a per-order snapshot so a later store-currency change can't rewrite a historical total.
- **Decrement stock on paid + oversell guard** (#26, PR #37) — inside the same
  `markPaidByPaymentIntent` transaction, each line is decremented with an atomic guarded
  `updateMany({ stock: { gte: quantity } })`, lines ordered by `variantId` (deadlock-safe
  under concurrent checkouts sharing a variant). A shortfall doesn't block the transition —
  it's collected and logged as a loud `OVERSELL` alert; the order stays `PAID`.

## Exit criteria

- [x] Admin creates a product with variants → it appears on the storefront — #10 (PR #20)
      writes it; #11 (PR #21) renders it (`catalogService.getStorefrontProducts` lists
      `ACTIVE` products only).
- [x] Shopper completes a Stripe **test-mode** checkout end-to-end — #12 (PR #22) cart →
      #13 (PR #24) PaymentIntent + Payment Element → `/checkout/success`.
- [x] A paid checkout produces an `Order` in state `PAID` via the **webhook** (not the
      client redirect), with correct line-item snapshots and total — #13 (PR #24) writes
      the `PENDING` order + `OrderItem` snapshots; #14 (PR #28) performs the atomic
      `PENDING` → `PAID` flip (`src/server/repositories/order.repository.ts:149-239`).
- [x] `/admin` is auth-protected; unauthenticated users are redirected — #9 (PR #18):
      `src/proxy.ts` (cookie gate) + `requireAdminContext` (authoritative session/membership
      check, redirects to `/sign-in`).
- [x] Order confirmation email is sent on success — #15 (PR #29): sent exactly once, from
      the webhook's `PENDING` → `PAID` transition.
- [x] `pnpm build`, `pnpm typecheck`, `pnpm lint` all green; CI passing on `development` —
      the CI and CodeQL workflows both report `success` on commit `28d24f8` (verified with
      `gh run list --commit 28d24f851bcbe0878f206b2308900b7c6052c476`).
- [x] Storefront pages are server-rendered with correct metadata (SEO) — #11 (PR #21):
      `generateMetadata` on the PDP (`src/app/(storefront)/products/[slug]/page.tsx:25-37`);
      list + PDP are both dynamic, DB-backed reads.

## Key decisions

Also appended to the `docs/ARCHITECTURE.md` §9 decision log.

- **Embedded Stripe PaymentIntent + Payment Element**, not hosted Checkout Sessions — full
  control over the success-page verification and the order-write timing; costs more
  client-side UI than a redirect to Stripe.
- **Cookie-backed guest cart**, `[{ variantId, qty }]` only, never price — a tampered
  cookie can at most name an invalid variant or an oversized qty, both rejected/clamped
  server-side; price/title/stock/total are always recomputed from a live `ProductVariant`
  read at cart-view and checkout time.
- **The Stripe webhook is the sole source of truth for "paid"** — an idempotent, atomic,
  status-guarded order state machine (`PENDING → PAID → FULFILLED`, plus
  `CANCELLED`/`REFUNDED` defined for later use); the browser redirect is UX only and never
  writes order state.
- **Stock is decremented atomically inside the same PAID transition**, not reserved at
  `PENDING` — oversell is surfaced (a logged shortfall, order stays `PAID`), not blocked;
  reservation-at-`PENDING` with an expiry sweep is a deferred follow-up (#25).
- **Single currency per tenant** — `Tenant.currency` is the one source; catalog, cart, and
  checkout can never mix currencies; `Order.currency` still snapshots it per order.
- **Variant deletion is FK-guarded, not soft-deleted** — `OrderItem.variant` is
  `onDelete: Restrict`; a variant already on an order can't be removed from the product
  form (a named-SKU error instead), only edited in place. True soft-flag/archive is
  deferred to #34.

## Known issues / tech debt

Filed from the M1 handoff review (`code-review` findings F1–F5):

- `#38` — the `Account.issuer NOT NULL` migration (`20260831105827_account_issuer`) has no
  default; `prisma migrate deploy` fails on any `Account` table that already had rows
  (a fresh deploy is unaffected — `Account` is still empty when it runs). Severity:
  deploy-blocking on a pre-existing DB. [M2]
- `#39` — `src/lib/env.ts` hard-requires `RESEND_API_KEY`/`EMAIL_FROM`
  (`z.string().min(1)`); a missing/blank value crashes the **whole app** at boot, not just
  email — contradicts the deliberately best-effort email design (the webhook already
  swallows send failures). Severity: high (storefront + checkout down over an email
  config gap). [M2]
- `#40` — an oversold line (see #26) still triggers the standard "order confirmed" email;
  no distinct/suppressed messaging for that case yet. Severity: low (cosmetic/support
  load). [M2]
- `#41` — `updateWithVariants` (`product.repository.ts`) runs in a `prisma.$transaction`
  with Prisma's default 5s timeout; the comparable order path
  (`markPaidByPaymentIntent`) explicitly raises it to 15s. A many-variant edit on a slow
  DB can abort with P2028. Severity: low (only under latency + many variants). [M2]
- `#42` — the storefront layout's cart-badge cookie read (`readCart()`) opts the whole
  subtree out of static caching; today it's moot because `getStoreTenant()` already forces
  dynamic rendering, so this only pays off alongside making the tenant read cacheable too.
  Severity: low, optimization only. [backlog]
- Prior deferrals from the build, still open (not regressions): `#25` dedupe
  PaymentIntents / sweep abandoned `PENDING` orders, `#27` Payment Element dark-mode
  appearance, `#30` reliable email delivery (outbox + retry), `#31` bound the Resend send
  with a timeout — all **[M2]**; `#34` soft-flag/archive variants — **[backlog]**; `#35`
  let an admin change the store currency — **[M2]**.
- **Operator note**: the seeded default admin (`prisma/seed.ts`) falls back to
  `SEED_ADMIN_EMAIL=admin@demo.test` / `SEED_ADMIN_PASSWORD=changeit-dev-only` when unset —
  dev-only; override `SEED_ADMIN_*` before seeding any shared/staging database.

## How to run & verify

```bash
docker compose up -d                 # Postgres on host port 55432
pnpm install
cp .env.example .env                 # then fill in the values below
pnpm db:migrate
pnpm db:seed                         # demo tenant, 5 products, seeded admin
pnpm dev                             # http://localhost:3000
```

Beyond `.env.example`'s defaults, fill in:

- `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` — test-mode keys from the
  Stripe dashboard.
- `STRIPE_WEBHOOK_SECRET` — printed by `stripe listen` below.
- `RESEND_API_KEY`, `EMAIL_FROM` — both are required just to boot (#39); a real key is
  needed to actually receive the confirmation email — `onboarding@resend.dev` works as the
  sender in Resend test mode.

In a second terminal, forward Stripe webhooks (needed because the webhook, not the
browser redirect, is what marks an order `PAID`):

```bash
stripe login                                                   # once, links the CLI
stripe listen --forward-to localhost:3000/api/webhooks/stripe  # prints whsec_...
```

Paste the printed `whsec_…` into `STRIPE_WEBHOOK_SECRET` in `.env` and restart `pnpm dev`.

**Happy path:**

1. Open `http://localhost:3000/sign-in`, sign in as the seeded admin (`admin@demo.test` /
   `changeit-dev-only`, or your `SEED_ADMIN_*` overrides).
2. Go to `/admin/products/new`, create a product with one `ACTIVE` variant (price in
   cents, some stock).
3. In a new/incognito tab, open `http://localhost:3000/products` — the product is listed;
   open its page and confirm the browser tab title / meta description match it.
4. From the PDP, add the variant to the cart; go to `/cart` and confirm the line, qty, and
   total.
5. Click through to `/checkout`, enter an email, and pay with the test card
   `4242 4242 4242 4242`, any future expiry, any CVC/postal code.
6. Land on `/checkout/success` — order number, line items, and total render.
7. Check the `stripe listen` terminal for a forwarded `payment_intent.succeeded`; check the
   `pnpm dev` log for `order for PaymentIntent ... marked PAID`.
8. Check the inbox for the email address entered at checkout — an "Order … confirmed"
   email with the same order number/total should arrive.
9. Back in `/admin/products`, open the product — the variant's stock is decremented by the
   purchased quantity.
10. From `/admin`, use the sign-out button, then try `/admin` directly — redirected to
    `/sign-in?redirect=%2Fadmin`.

A duplicate webhook delivery is a safe no-op: `stripe trigger payment_intent.succeeded`
against an already-paid intent leaves the order `PAID` and does not re-email or
double-decrement stock.

## Inherited by next milestone

M2 can assume:

- The tenant-scoped repository layer + RBAC (`OWNER > ADMIN > STAFF` via `Membership`,
  `src/config/roles.ts`).
- The `Order` state machine (`PENDING → PAID → FULFILLED`; `CANCELLED`/`REFUNDED` defined
  but unused) and the Stripe webhook as its only writer.
- The cookie cart, admin catalog CRUD, and single-currency store (`Tenant.currency`).
- The fulfillment provider seam (`src/server/fulfillment/provider.ts`, a `printful.ts`
  stub) — the order flow depends only on the interface, so suppliers stay swappable.

Seams left open on purpose (tracked, not blocking): stock is decremented at capture, not
reserved at `PENDING` (#25); email delivery is one best-effort send with no retry (#30,
#31); variants are FK-guarded, not soft-deletable (#34); one currency, no settings UI to
change it (#35). M2 scope (per the GitHub Milestone description): RBAC surfacing,
analytics dashboard, inventory, webhook state-machine expansion, search, tests,
observability — plus the #38/#39/#40/#41 fixes above.

## Links

- Release: **`vM1`** — pending (release PR `development` → `main` + tag not yet cut).
- Milestone: GitHub Milestone "M1 — commerce-slice" (#1) — 11/11 issues closed.
- Merged PRs: #17 (docs/kickoff), #18 (closes #9), #20 (closes #10), #21 (closes #11),
  #22 (closes #12), #24 (closes #13), #28 (closes #14), #29 (closes #15),
  #32 (closes #16), #33 (closes #19), #36 (closes #23), #37 (closes #26).
- Closed issues: #9, #10, #11, #12, #13, #14, #15, #16, #19, #23, #26.
- Changeset: `main...development` — 28 commits, 81 files
  (`git diff main...development --stat`).
- Follow-ups filed at handoff: #38, #39, #40, #41, #42.
