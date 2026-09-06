# M6 — UI redesign (storefront)

Resume the **Claude Design UI-redesign track**, deliberately paused during M5 so products
could get real images first (`docs/milestones/M5-product-images/handoff.md`). Every
remaining storefront screen gets restyled to the bar set by the pre-pause PDP pass
(PR #183), **screen by screen, ~one PR per screen**, via the visual-first `/design`
workflow. This is a **UI-only** milestone — the counterpart discipline to M5's
data/feature work: change presentation, never business logic.

Scope was fixed at `/milestone-start` (this doc + [`research.md`](research.md)). The M1–M5
rules are non-negotiable: tenant-isolated, layered (UI → service → repository → Prisma),
money in integer cents, server-only stays server-only. Here the operative rule is stricter
still: **restyle presentation, never touch data.**

## Goal

Restyle every remaining storefront surface — shared chrome (header/footer), product
listing, search, cart, the checkout shell, order confirmation, the shopper account/order
pages, and the auth screens — plus the platform landing page, to the `docs/DESIGN.md` bar
(restraint, one OKLCH accent, a real type scale, a 4px grid, shadcn primitives, lucide
icons, accessible by default), matching approved Claude Design canvases. Light + dark
correct; every existing state (loading/empty/error/disabled) preserved; every data shape,
Server Action, query, and tenant scope untouched.

## The UI-only contract (from research — see [`research.md`](research.md))

- **Presentation only.** No change to data shapes, Server Actions, repository/service
  queries, tenant scoping, or Stripe internals. Restyle the Server Component page itself
  where possible; keep client-component **props + action-call contracts** byte-for-byte
  (`PurchasePanel` proved this in PR #183; the same discipline binds `CartItems` and
  `CheckoutForm`).
- **Preserve E2E selectors.** The suite runs on a production build with accessible-name
  queries — restyling classes/wrappers is safe; changing text content, label
  associations, or ARIA roles is not. The exact strings each screen must keep are
  enumerated in `research.md` Risk #1 and repeated in each issue.
- **Two silent traps.** (1) `checkout/checkout-appearance.ts` themes the Stripe Payment
  Element from OKLCH tokens → a regression there fails no test, it just reverts the widget
  to Stripe's default, so checkout PRs are verified manually in light **and** dark. (2)
  `notFound()` soft-404: adding a route-level `loading.tsx` under `/products/[slug]` or
  `/account/orders/[id]` turns a real 404 into a 200 — use a component-local `<Suspense>`
  instead.
- **New primitives only on demand.** Add `Skeleton` + `Breadcrumb` up front (both already
  have consumers); defer `Sheet`/`Toast`/etc. until a canvas needs one. Any new
  body-portal overlay must stamp `TENANT_THEME_PORTAL_ATTR` or the tenant accent drops
  inside it.
- **Container-width-by-density is intentional** — `max-w-6xl` (listing/PDP), `max-w-5xl`
  (cart/checkout), `max-w-2xl`/`3xl` (account). Keep it; don't flatten to one width.

## In scope

- Screen-by-screen restyle via `/design`, UI-only, ~one PR per screen: design-system prep
  (Skeleton + Breadcrumb) → shared chrome → listing → search → cart → checkout shell →
  order confirmation → account (home/orders/detail) → auth (sign-in/up).
- The **platform landing page** `src/app/page.tsx` + a copy refresh (the stale "Phase 0"
  badge). _Note:_ the research brief recommended this **out** of scope (it's the platform
  apex page, not a `(storefront)` screen — a tenant `/` 302-redirects to `/products`);
  kept **in** by an explicit scope decision at `/milestone-start` for portfolio leverage.
- Hold `docs/DESIGN.md`; keep all existing states; add per-row cart thumbnails **only** if
  the cart read already carries image data (else defer — see Out of scope).

## Out of scope (defer)

- Any data / business-logic / schema change; new features (no "forgot password", no
  related-products rail, no new routes).
- Widening a query to feed the UI (e.g. cart-row thumbnails) — if the data isn't already
  loaded, that's a data change; defer, or note it here as an explicit exception.
- Re-theming the Stripe Payment Element internals / `checkout-appearance.ts` logic beyond
  reading from it.
- The **admin dashboard** redesign — its own later track (denser context).
- A real per-tenant storefront landing page (a product/content decision, not a restyle).

## Exit criteria

_Finalized at `/milestone-start`. Adjust only with a note here if building forces a change._

- [ ] Every in-scope screen restyled to the DESIGN.md bar; light + dark correct; AA
      contrast; all states (loading/empty/error/disabled) intact; keyboard + focus-visible;
      responsive, no horizontal body scroll.
- [ ] UI-only held: no change to data shapes, Server Actions, repository/service queries,
      tenant scoping, or `checkout-appearance.ts` / Payment Element internals;
      `PurchasePanel` / `CartItems` / `CheckoutForm` keep props + action calls.
- [ ] `pnpm build && pnpm test:e2e` green (all specs); the preserved selectors (research
      Risk #1) intact — incl. the shared auth-form labels/buttons across the storefront
      **and** platform surfaces, plus `account-menu.test.tsx`.
- [ ] Checkout + confirmation manually verified in both light and dark OS scheme (Payment
      Element theming, Risk #3).
- [ ] New primitives added only on demand (Skeleton + Breadcrumb ship in #206); no
      speculative deps; any new body-portal overlay stamps `TENANT_THEME_PORTAL_ATTR`.
- [ ] `pnpm typecheck && pnpm lint` clean throughout; each PR small and single-screen.
- [ ] Docs: `research.md` (done), this `GOAL.md`, `handoff.md` at close; the roadmap row
      in [`../README.md`](../README.md) updated.

## Dependencies / sequencing

- **Depends on M5 (done):** real product images now fill the card + PDP gallery slots this
  redesign styles.
- **Chrome first** (everything renders inside it); **auth last** (its shared forms also
  drive admin sign-in + onboarding — the biggest E2E blast radius). The product card is
  already at-bar from M5 — no rework. Full order in the GitHub milestone description.
- No dependency on M4 fulfillment beyond the shared product/tenant models.

## GitHub

- Milestone: **M6 — ui-redesign** (#6).
- Issues **#206–#215** (build order), labelled `phase:M6`, `type:feat`/`type:chore`,
  `area:ui` (+ `area:payments` on checkout/confirmation, `area:auth` on auth); each ≈ one PR:
  - #206 M6-01 design-system prep (Skeleton + Breadcrumb)
  - #207 M6-02 shared chrome (header + footer)
  - #208 M6-03 product listing
  - #209 M6-04 search results
  - #210 M6-05 cart
  - #211 M6-06 checkout shell
  - #212 M6-07 order confirmation
  - #213 M6-08 account (home + orders list + detail)
  - #214 M6-09 auth (sign-in + sign-up)
  - #215 M6-10 landing page + copy refresh
