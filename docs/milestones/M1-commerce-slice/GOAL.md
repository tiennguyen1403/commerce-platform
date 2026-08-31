# M1 — Commerce slice

Turn the scaffold into a working store: a shopper can browse products and complete a real
(test-mode) purchase, and an admin can manage the catalog. This is the milestone that makes
the project demoable.

## In scope

- **Admin catalog CRUD** — create/edit products + variants (price in cents, stock, status),
  scoped to the tenant.
- **Storefront** — product list + product detail page (PDP), rendered from the DB (SSR/ISR
  for SEO), reading the seeded `demo` tenant.
- **Cart** — add/remove/update quantity (**cookie-backed** — decided in research).
- **Checkout** — Stripe Payment Intent; create `Order` + `OrderItem`s with price snapshots.
- **Order confirmation** — success page + a transactional email (Resend).
- **Webhook** — Stripe webhook drives `PENDING → PAID` idempotently.
- **Auth surface** — sign-in/up for admin; protect `/admin`.

## Out of scope (later milestones)

Multi-tenant onboarding & subdomains (M3), analytics dashboard (M2), inventory reservation,
Stripe Connect payouts, fulfillment/POD (M4), full test suite (M2 hardening).

## Exit criteria

- [x] Admin can create a product with variants; it appears on the storefront. (PR #20, #21)
- [x] Shopper can complete a Stripe **test-mode** checkout end-to-end. (PR #22, #24)
- [x] A paid checkout produces an `Order` in state `PAID` via the **webhook** (not the
      client redirect), with correct line-item snapshots and total. (PR #24, #28)
- [x] `/admin` is auth-protected; unauthenticated users are redirected. (PR #18)
- [x] Order confirmation email is sent on success. (PR #29)
- [x] `pnpm build`, `pnpm typecheck`, `pnpm lint` all green; CI passing on `development`. (CI green @ 28d24f8)
- [x] Storefront pages are server-rendered with correct metadata (SEO). (PR #21)

## Decisions (settled at research)

- **Payment:** embedded Stripe **PaymentIntent + Payment Element** (not hosted Checkout Sessions).
- **Cart:** **cookie-backed** (`[{ variantId, qty }]`, never price; always recomputed server-side).

See [`research.md`](research.md). Tracked as GitHub issues **#9–#16** in milestone _M1 — commerce-slice_.

## Suggested issue breakdown

1. Tenant context helper + auth-protected `/admin` shell (#9).
2. Admin: product list + create/edit forms (variants, cents, status) (#10).
3. Storefront: product list + PDP from DB (SSR/ISR + metadata) (#11).
4. Cart — cookie-backed (#12).
5. Stripe checkout: Payment Intent + Order creation with snapshots (#13).
6. Stripe webhook: idempotent order state machine (#14).
7. Order confirmation page + Resend email (#15).
8. Polish pass against `docs/DESIGN.md` (#16).
