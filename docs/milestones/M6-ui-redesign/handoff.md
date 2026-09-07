# Handoff — M6 UI redesign

> Written at milestone close (by the `scribe` agent).

Restyles every remaining storefront surface — shared chrome, product listing, search,
cart, the checkout shell, order confirmation, the shopper account cluster, and auth —
plus the platform's apex landing page, to the `docs/DESIGN.md` bar set by the pre-pause
PDP pass (PR #183), screen by screen via the visual-first `/design` workflow (10 issues,
one PR each, #206–#215, all closed). This is the **UI-only** counterpart to M5's
data/feature milestone: presentation changed, business logic didn't, with exactly one
sanctioned exception — a minimal read addition so the cart and checkout summary can show
a real product thumbnail per row (#210). Scope held to the 10 issues fixed at kickoff
(unlike M4's 9→21): the landing page was an explicit, disclosed scope decision made _at_
`/milestone-start`, not a mid-build creep, and the only unplanned addition — a shared
Base UI crash-on-open bug in the account menu and admin store-switcher — was fixed inline
as PR #225 rather than filed as a new issue.

## Shipped

- **Skeleton + Breadcrumb primitives** (#206, PR #217) — `src/components/ui/skeleton.tsx`
  (a `bg-muted animate-pulse` box) and `src/components/ui/breadcrumb.tsx` (composable
  `List`/`Item`/`Link`/`Page`/`Separator`), both base-nova style (`useRender`/
  `mergeProps`, a `render` prop rather than `asChild`, server-safe, no `"use client"`);
  wired into the PDP breadcrumb (`products/[slug]/page.tsx`, a visual no-op) and the
  streamed grid fallback (`product-grid-skeleton.tsx`), which also picked up an
  accessibility fix in the same PR — the loading grid now announces via `role="status"` /
  `aria-live="polite"` / an `sr-only` "Loading products" label instead of rendering
  silently.
- **Shared storefront chrome — header, mobile drawer, footer** (#207, PR #218) —
  `src/app/(storefront)/layout.tsx` reworked into brand+nav on the left, search/cart/
  account grouped on the right; a new mobile `Sheet` drawer (`src/components/ui/sheet.tsx`,
  `mobile-nav.tsx`) carries search/nav/account under a hamburger and stamps
  `TENANT_THEME_PORTAL_ATTR` on its body portal so the tenant accent survives it; a real
  multi-column footer; sign-out logic extracted into a shared `useSignOut` hook
  (`account/use-sign-out.ts`) reused by the desktop `AccountMenu` and the drawer.
  `layout.tsx` stays a Server Component — the `[data-tenant-theme]` wrapper and the
  tenant/session/cart reads are untouched.
- **Product listing restyle** (#208, PR #219) — `products/page.tsx` gains a result-count
  toolbar ("N products", tabular-nums) on a hairline border between the header and the
  grid; the empty state adopts the house tinted-circle badge (`PackageX`, `aria-hidden`);
  `product-grid-skeleton.tsx` mirrors the new toolbar. `force-dynamic` and the
  component-local `<Suspense>` (no route-level `loading.tsx`, which would soft-404 the
  PDP) are unchanged.
- **Search results restyle** (#209, PR #220) — `search/page.tsx` echoes the query in the
  header and moves the count into the same hairline toolbar as `/products`; zero-match and
  empty-query states get the tinted-circle badge; the plain Prev/Next pager is replaced by
  a centered, windowed, keyboard-operable numbered pager, its pure page-window math
  extracted to `src/lib/pagination.ts` (`paginationRange`) with its own unit tests
  (`pagination.test.ts`). The `q`/`page` URL params and `force-dynamic` are unchanged.
- **Cart restyle + the one data exception** (#210, PR #221) — `cart-items.tsx` gets a
  `ProductImageFrame` thumbnail per row and `page.tsx` the tinted-circle empty state plus a
  `Lock`-icon trust line; the `CartItem[]` prop and the `updateQtyAction`/
  `removeFromCartAction` calls stay byte-identical. The thumbnail needed data the cart
  read didn't carry, so `findVariantsForTenant`
  (`src/server/repositories/product.repository.ts:197-216`) now also selects the
  product's primary image (`take: 1`, ordered by `position`), `CartItem`
  (`src/lib/cart.ts:62-77`) gains a display-only `image`, and `cartService.getCartView`
  (`src/server/services/cart.service.ts:80-93`) maps it — recorded as the milestone's one
  sanctioned exception in `GOAL.md`.
- **Checkout shell restyle** (#211, PR #222) — a two-step `Details → Payment` progress
  indicator (`aria-current="step"`); the phase-1 form and phase-2 review both regrouped
  into `SectionPanel`s (a new local Card + accent icon chip + heading shell,
  `checkout-form.tsx`); the order-summary card gets per-row `ProductImageFrame`
  thumbnails (fed by the same widened cart-view read — no further query change) and a
  "secure checkout" footer. `startCheckoutAction`, the two-phase started-state machine,
  the `matchMedia` dark-mode subscription, the `<Elements>` mount, and every E2E label/
  button are untouched; `checkout-appearance.ts` and the Payment Element itself are
  unchanged and were manually reverified in light + dark.
- **Order confirmation restyle** (#212, PR #223) — `checkout/success/page.tsx` rebuilt
  around a shared tinted-status-circle hero (with an order-number pill on succeeded/
  processing) over the checkout's `SectionPanel` idiom; failed gets a destructive recovery
  card, invalid a distinct neutral not-found treatment. The recap's new Ship-to +
  confirmation-email block reads fields already on the `Order` row (#135) — no new query.
  The four-way view logic, the exact "Payment received" heading, and `force-dynamic` are
  unchanged.
- **Account hub, orders, and order detail restyle** (#213, PR #224) — account home becomes
  a hierarchical hub (identity header, an "Order history" panel, an "Account details"
  panel); the orders list gets a tinted table header, `tabular-nums`, and the tinted-circle
  empty state; order detail replaces its back-link with a `Breadcrumb` (Account → Orders →
  number) and panelizes Shipping/Order-details via a local `account/section-panel.tsx`.
  The `getShopperSession` gate + redirects, `force-dynamic`, the soft-404 (no loading
  boundary under `[id]`), and every tenant+user-scoped read are unchanged.
- **Fix: account-menu / store-switcher crash-on-open** (PR #225, no issue — a shared-chrome
  bug surfaced while restyling M6-08) — `DropdownMenuLabel` (Base UI's `Menu.GroupLabel`)
  requires a `Menu.Group` ancestor; rendered bare in `account-menu.tsx` and the admin
  `store-switcher.tsx`, opening either menu threw Base UI error #31 at runtime, which the
  error boundary surfaced as a blank "This page couldn't load." Both now wrap the label in
  a `DropdownMenuGroup`. Reproduced on every storefront route before the fix; verified
  clean in a production build after it.
- **Auth restyle — sign-in/up cards, then a v2 split stage** (#214, PR #226) — v1 wraps
  both forms in a header-chip `Card` matching the account cluster's idiom, plus a shared
  show/hide `PasswordInput` (`components/auth/password-input.tsx`) with a deliberately
  collision-free "Show"/"Hide" accessible name (a "Show password" name would
  substring-match the specs' `getByLabel("Password")`). Same PR, by a same-day product
  decision, adds a v2 `AuthStage` side panel (`account/auth-stage.tsx`) on the tenant
  accent tint, plus two disabled "Coming soon" placeholders — a forgot-password link and a
  `PlannedSocialSignIn` Google/Apple row — with no auth logic, route, or provider added
  (see `GOAL.md` → Exceptions). `SignInForm` gained one optional `passwordAction` slot the
  platform admin sign-in/onboarding pages never pass, so those surfaces render unchanged.
- **Apex landing restyle + copy refresh** (#215, PR #230) — `src/app/page.tsx` rebuilt to
  the "Platform Landing Redesign" canvas (Direction A): one primary action repeated in a
  closing band, a hero stage (`landing-stage.tsx`) rendering two seeded stores (Demo
  Store, Aurora) via a new `scopedThemeCss(selector, hue)` (extracted from
  `tenantThemeCss`, `src/lib/theme.ts`, byte-identical output asserted in
  `theme.test.ts`), and a "What's live" section + milestone ladder replacing the stale
  "Phase 0" badge. The four link targets, the Button render-prop link pattern, and the
  page's static (no tenant/session/DB read) prerender are unchanged; a same-day
  review-fixes commit corrected the seeded product count, an inaccurate fulfillment claim,
  a sub-AA stack-chip color pair, and added `e2e/landing.spec.ts`. Filed **#229** as a
  follow-up: the "Shop the store" CTA's relative `/products` link 404s on the apex host
  (it needs the demo store's own subdomain — a logic change, out of scope here).

## Exit criteria

All seven checklist items in `GOAL.md` — the source of truth, condensed below with
evidence.

- [x] **Every in-scope screen restyled** — light + dark correct, AA contrast, all states
      (loading/empty/error/disabled) intact, keyboard + focus-visible, responsive — all 10
      screens (#206–#215) restyled screen-by-screen via `/design` against the shared
      `docs/DESIGN.md` bar; each PR's own commit message (see Shipped) attests the states
      it verified; a light/dark × desktop/mobile screenshot pass ran at handoff.
- [x] **UI-only held** — no change to data shapes, Server Actions, repository/service
      queries, tenant scoping, or `checkout-appearance.ts`/Payment Element internals;
      `PurchasePanel`/`CartItems`/`CheckoutForm` keep props + action calls — verified PR by
      PR; the **one** sanctioned crossing is the cart-row image read (#210/PR #221),
      recorded in `GOAL.md` → Exceptions; `checkout-appearance.ts` and the Payment Element
      untouched throughout.
- [x] **`pnpm build && pnpm test:e2e` green (all specs)** — CI (`verify`, `test-db`,
      `e2e`, `dispatch`) and CodeQL (`Analyze (javascript-typescript)`) all green on
      `development` at `84e18ea` (the release commit, GitHub Actions); local `pnpm build`
      also clean. Preserved selectors (research Risk #1) intact throughout, incl. the
      shared auth-form labels/buttons across storefront **and** platform surfaces (PR
      #226: "6/6 e2e across all four specs") and `account-menu.test.tsx`.
- [x] **Checkout + confirmation manually verified in light and dark** — PR #222/#223
      commit messages attest manual dark-mode verification of the Payment Element and all
      four confirmation states; PR #226's v2 stage manually checked light + dark, desktop + mobile.
- [x] **New primitives added only on demand** — `Skeleton` + `Breadcrumb` shipped up front
      in #206/PR #217 (both already had consumers); `Sheet` added only once #207's mobile
      chrome needed a drawer, and its body portal stamps `TENANT_THEME_PORTAL_ATTR`
      (`mobile-nav.tsx`); no speculative dependency was added — `package.json`/
      `pnpm-lock.yaml` have zero diff across the whole milestone
      (`git diff vM5..development --stat -- package.json pnpm-lock.yaml`).
- [x] **`pnpm typecheck && pnpm lint` clean throughout; each PR small and single-screen** —
      attested in every commit message; #206–#215 map 1:1 to PRs #217–#230, with #225 the
      one unplanned (and still single-purpose) fix.
- [x] **Docs** — `research.md` (done at kickoff, PR #216), this `GOAL.md` (amended twice
      in-flight for the #210 and #214-v2 exceptions), this `handoff.md`, and the roadmap
      row in `docs/milestones/README.md` updated to `✅ done`.

## Key decisions

All five appended to `docs/ARCHITECTURE.md`'s §9 decision log; condensed here.

- **UI-only milestone discipline as a first-class constraint, not just a convention** —
  every restyle PR keeps its client component's props and Server Action calls
  byte-identical (`PurchasePanel`/`CartItems`/`CheckoutForm`); the one sanctioned crossing
  (the cart-row image read, #210) is named explicitly in `GOAL.md` → Exceptions rather
  than left implicit.
- **Shared primitives added on demand, not upfront** — `Skeleton` + `Breadcrumb` landed
  first (#206, both already had consumers); `Sheet` landed only once the mobile chrome
  needed a drawer (#207). Both follow the base-nova pattern (`useRender`/`mergeProps`, a
  `render` prop rather than `asChild`, server-safe); any new body-portal overlay stamps
  `TENANT_THEME_PORTAL_ATTR`.
- **`scopedThemeCss(selector, hue)` extracted from `tenantThemeCss`** (#215) — lets the
  apex landing paint two seeded store themes on one static page without touching the
  single-tenant theming path; byte-identical output is asserted in `theme.test.ts`, and
  `themeHueSchema`'s 0–359 validation still gates every hue that reaches it.
- **The `SectionPanel` idiom kept as small local copies, not extracted early** — checkout,
  order-confirmation, and account each carry their own server-safe Card, accent icon chip,
  heading, and description shell rather than a shared component pulled out after only
  three call sites.
- **The apex landing page kept inside a UI-only milestone by explicit scope decision** —
  it's the platform's `/`, not a `(storefront)` screen (a tenant host's `/` redirects to
  `/products`), so research recommended it out; kept in for portfolio leverage. It stays
  fully static — no tenant/session/DB read — and prerenders at build.

## Known issues / tech debt

Two review passes ran at handoff. The `security-review` skill found **no HIGH/MEDIUM
findings at confidence ≥ 8** — it cleared the `theme.ts` CSS path (the `hue` is
zod-validated 0–359, falling back to a default; every `scopedThemeCss` selector and the two
landing-stage hues are hardcoded literals; all three `dangerouslySetInnerHTML` theme-CSS
sinks receive only validated/hardcoded values), the cart image read's tenant scope, and
confirmed auth logic/redirects (`safeInternalPath`) and `getShopperSession` gates are
untouched with no new route/action/secret surface. The `reviewer` agent's independent
structural pass found the milestone **ship-ready — no blockers**: the cart data exception
is safe and minimal (tenant-scoped, contracts byte-identical, the over-fetch harmless),
the mobile `Sheet` drawer correctly stamps the portal attribute, and no route-level
`loading.tsx` was added anywhere the `notFound()` soft-404 needed protecting.

- **A storefront "v2" consistency pass is deferred to M7 (storefront-v2).** The design
  bar rose across this milestone: the last two screens — auth (#226) and the apex landing
  (#230) — were built to the newer "Fable v2" canvases (split stage, hero), and a PDP "v2"
  canvas is designed but not yet built, while the earlier seven storefront surfaces hold
  the M6 baseline. Raising them all to that shared v2 bar is M7.
- **The admin dashboard redesign is deferred to M8** — this milestone was explicitly
  storefront + platform-landing only; `src/app/(admin)/admin/**` is unchanged and still
  reads at the pre-M6 visual bar.
- **Real forgot-password and social sign-in logic is deferred to a future auth
  milestone** — M6-09 v2 shipped only the disabled "Coming soon" visual placeholders (a
  link + `PlannedSocialSignIn`), with no route, provider, or auth logic behind either.
- **#229 — "Shop the store" 404s on the apex host.** The landing's demo CTA links to a
  relative `/products`, which has no tenant on the apex/reserved-subdomain host the
  landing actually renders on. Filed during M6-10 as a small, scoped logic fix (point at
  the demo store's own subdomain) rather than folded into the UI-only PR.
- **A real per-tenant storefront landing page remains deferred** (`GOAL.md` → Out of
  scope) — a product/content decision, not a restyle.

## How to run & verify

```bash
docker compose up -d                 # Postgres on host port 55432
pnpm install
cp .env.example .env
pnpm db:migrate                      # no new migration this milestone (UI-only)
pnpm db:seed
pnpm dev                             # http://localhost:3000
```

```bash
pnpm test                            # unit — no infra, seconds
pnpm test:integration                # needs `docker compose up -d` (Postgres on 55432)
pnpm build && pnpm test:e2e          # Playwright boots `pnpm start` itself
```

**Happy path** — M1–M5's flows (browse → cart → checkout → PAID; subdomains; search;
shopper accounts; fulfillment; product images) are functionally unchanged; see their
handoffs. On top of it, every screen below now matches the redesigned PDP:

1. Visit the apex, `http://www.localhost:3000/` (bare `localhost` 307s straight to
   `/products` — the landing only renders on `www.` or a real apex host) — the restyled
   hero stage with two seeded store windows, the "What's live" section, and the milestone
   ladder.
2. Visit a store's storefront (e.g. `http://demo.localhost:3000/products`) — the
   redesigned header (nav left, search/cart/account right); shrink the window to see the
   hamburger open the mobile `Sheet` drawer; scroll to the new multi-column footer.
3. Browse `/products` and `/search?q=…` — both show the count toolbar and the
   tinted-circle empty state (try a zero-match search on the latter).
4. Add an item to the cart — the row shows a real product thumbnail (or the placeholder
   for an image-less product); adjust quantity / remove; go to `/checkout` — the two-step
   indicator, panelized Contact/Shipping/Payment sections, and the summary's per-row
   thumbnails.
5. Complete a test-mode payment — `/checkout/success` shows the panelized recap (Order
   summary + Shipping to); toggle the OS dark scheme too — the Payment Element stays
   themed.
6. Sign in (or sign up) on the storefront — the header-chip card, the show/hide password
   toggle, and, on the split-stage layout, the disabled "Coming soon" forgot-password link
   and social row.
7. Visit `/account`, `/account/orders`, and an order's detail page — the hierarchical hub,
   the tinted table, and the `Breadcrumb`.

## Inherited by next milestone

The design system this milestone built out — `Skeleton` + `Breadcrumb` (#206), `Sheet`
(#207), the `SectionPanel` idiom (checkout/confirmation/account), the tinted-circle
empty-state idiom (listing/search/cart/orders), and `scopedThemeCss` (#215) — is now the
shared vocabulary the next milestones reuse rather than reinvent; any future
body-portal overlay must keep stamping `TENANT_THEME_PORTAL_ATTR` the way the mobile
`Sheet` drawer does. Seams and fast-follows left open on purpose — see Known issues above
for the full list:

- A storefront "v2" consistency pass — **M7 (storefront-v2)**: raise the seven baseline
  M6 screens to the "Fable v2" bar auth and the landing already hit, starting from the
  already-designed (frozen, not-yet-built) PDP v2 canvas.
- The admin dashboard redesign — **M8**.
- Real forgot-password + social sign-in logic (only the visual placeholders shipped).
- #229 — point "Shop the store" at the demo store's own subdomain.
- A real per-tenant storefront landing page.

## Links

- Release: **`vM6`** — pending (release PR `development` → `main` + tag cut at handoff).
- Milestone: GitHub Milestone "M6 — ui-redesign" (#6) — 10/10 closed, 0 open.
- Review: `security-review` skill — no HIGH/MEDIUM findings at confidence ≥ 8. `reviewer`
  agent structural pass — ship-ready, no blockers.
- Merged PRs: #205 (docs: M6 seed stub, at the M5 handoff), #216 (docs: M6 kickoff plan +
  research), #217 (closes #206), #218 (closes #207), #219 (closes #208), #220 (closes
  #209), #221 (closes #210), #222 (closes #211), #223 (closes #212), #224 (closes #213),
  #225 (fix: account-menu/store-switcher crash-on-open — no issue), #226 (closes #214),
  #230 (closes #215).
- Closed issues (10, milestone-tagged): #206, #207, #208, #209, #210, #211, #212, #213,
  #214, #215. Follow-up filed, not milestone-tagged: #229.
- Changeset: `vM5..development` — 31 commits, 47 files, +3,670 / −717
  (`git diff vM5..development --shortstat`).
