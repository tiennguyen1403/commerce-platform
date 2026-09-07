# Research — M6 UI redesign (storefront)

> Produced at milestone start (by the `researcher` agent). Read before building.
> **UI-only milestone**: restyle presentation; never change data shapes, Server
> Actions, repository/service queries, tenant scoping, or Stripe internals.

## Context & goal

Resume the Claude Design UI-redesign track, paused during M5 so the product card and
PDP gallery could get real photography first (`docs/milestones/M6-ui-redesign/GOAL.md:8-15`).
The PDP was already redesigned (PR #183, `src/app/(storefront)/products/[slug]/page.tsx` +
`purchase-panel.tsx`) before M5 slotted real images into its gallery (PR #197,
`product-gallery.tsx`/`product-image.tsx`). This milestone restyles every **remaining**
storefront screen to the same bar, screen by screen, ~one PR per screen, holding the
line on `docs/DESIGN.md` (restraint, one accent, real type scale, 4px grid, shadcn
primitives, lucide icons, accessible by default). Out of scope: any data/business-logic
change, re-theming Stripe internals beyond presentation, and the admin dashboard
(`docs/milestones/M6-ui-redesign/GOAL.md:26-30`).

No GitHub Milestone/issues exist yet for M6 (`gh api repos/:owner/:repo/milestones` and
`gh issue list --search 'milestone:"M6"'` both return empty) — this brief is the input
to `/milestone-start`'s task breakdown. Most recently merged PR is #205, so new issues
will number from roughly #206.

## Key questions

- Is the apex `/` landing page (`src/app/page.tsx`) in scope for M6 at all? It is not
  part of the `(storefront)` route group and carries no tenant context — see the
  "Landing/home" finding below. Recommend: **out of scope**, flag its stale "Phase 0"
  copy separately.
- Does the redesign want a mobile nav drawer (needs the missing `Sheet` primitive), or
  is the header's current `flex-wrap` behavior (`layout.tsx:47`) good enough?
- Should the footer (`layout.tsx:95-99`, one line of copyright) grow content as part of
  "shared chrome," or just get restyled as-is? GOAL.md's in-scope list says "footer" but
  calls it "thin" in the task brief — this is a scope call, not a styling one.
- Which new shadcn primitives (if any) get a dedicated prep issue before screen work
  starts, vs. being added inline with the screen that first needs them?
- The auth screens (`/account/sign-in`, `/account/sign-up`) render through
  `SignInForm`/`SignUpForm` components **shared with the platform's own `/sign-in`,
  `/sign-up`** (admin/onboarding). Restyling the shared form internals is a
  cross-surface change — confirm this is understood before that issue is scoped (see
  Risks).

## Findings

### Framework / APIs — Next 16.3.3 / React 19.2.8 (verified against `node_modules/next/dist/docs/` and `package.json`)

- **Server Components are the default; `"use client"` is a small, deliberate island.**
  Every page in `(storefront)` is an `async function` Server Component reading
  `getStoreTenant()`/`getShopperSession()`/cookies directly; the only client
  components are the ones that truly need interactivity: `purchase-panel.tsx`,
  `product-gallery.tsx`, `cart-items.tsx`, `checkout-form.tsx`, `account-menu.tsx`,
  `sign-in-form.tsx`/`sign-up-form.tsx`, `checkout-complete.tsx`. Match this shape for
  any new component — restyle the Server Component page itself wherever possible.
- **`next/image`: `preload`, not `priority`.** Confirmed in the installed docs —
  `priority` was deprecated in Next 16.0.0 in favor of `preload`
  (`node_modules/next/dist/docs/01-app/03-api-reference/02-components/image.md:291-293,1404`).
  Already followed correctly: `product-image.tsx:57` (`preload={preload}`), the PDP
  gallery's main image (`product-gallery.tsx:37`), and the first grid card
  (`products/page.tsx:50`, `search/page.tsx:125`). Keep using `preload` on exactly one
  LCP image per page; don't reintroduce `priority`.
- **`notFound()` soft-404 caveat is real and doc-confirmed.** Per
  `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/not-found.md:83-122`
  and `.../03-file-conventions/loading.md:101-122`: once a response starts streaming
  (a `loading.tsx`, or a `<Suspense>` fallback rendering), the HTTP status is already
  committed to `200` — a later `notFound()` only injects `<meta name="robots"
  content="noindex">`, a "soft 404." `account/orders/[id]/page.tsx:58-66` calls this
  out explicitly: it `await`s `orderService.getOrderForUser` directly (no
  `<Suspense>`, no `loading.tsx` in that segment) specifically so `notFound()` yields a
  real 404. **Any redesign that adds a route-level `loading.tsx` under `/account` or
  `/products/[slug]` would silently break this.** Use a component-local `<Suspense>`
  instead (the pattern `products/page.tsx:68-70` + `product-grid-skeleton.tsx` already
  establishes) when a screen wants a streamed skeleton.
- **`export const dynamic = "force-dynamic"` is still fully live** — not deprecated.
  The route-segment-config docs show `dynamic`/`dynamicParams`/`revalidate`/
  `fetchCache` are removed **only** when Cache Components is enabled
  (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/index.md:15-19`,
  v16.0.0 entry). `next.config.ts` sets no `cacheComponents` flag, so this app is on
  the classic model and every existing `force-dynamic` export
  (`products/page.tsx:13`, `search/page.tsx:17`, `cart/page.tsx:28`,
  `checkout/page.tsx:20`, `checkout/success/page.tsx:18`, `account/page.tsx:19`,
  `account/orders/page.tsx:31`, `account/orders/[id]/page.tsx:32`,
  `account/sign-in/page.tsx:12`, `account/sign-up/page.tsx:10`) stays correct and
  required. **Any new page that reads the tenant/session/cart must carry the same
  export**, or the DB-less CI build fails at prerender (this bit M5; see
  `docs/DATABASE.md` and the memory note it's grandfathered from).
- **Metadata**: every page already exports a static `metadata: Metadata` object
  (title/description) except the dynamic PDP, which uses `generateMetadata`
  (`products/[slug]/page.tsx:33-45`). Nothing to change here for a UI-only pass.
- (Aside, not this milestone's surface) the admin subtree gets `force-dynamic` for
  free via its layout's `headers()` call — the storefront opts in per-page instead,
  because the shared `(storefront)/layout.tsx` itself has no such implicit trigger on
  every child route (it does call `getStoreTenant()`/`getShopperSession()`, but a
  child page's own prerender pass is decided by that page's own exports/reads).

### Libraries / primitives — shadcn/ui `base-nova` on Base UI 1.7 (`components.json:4`, `package.json:29`)

**Exists in `src/components/ui/`:** `button`, `badge`, `card`, `dialog`, `field`,
`input`, `label`, `separator`, `table`, `textarea`, `dropdown-menu`, `select`.

- **`render` prop, not `asChild`** — confirmed in every primitive read: `Button`
  wraps `@base-ui/react/button` and takes `nativeButton`/`render`
  (`button.tsx:1,43-56`; usage e.g. `cart/page.tsx:59` `nativeButton={false}
  render={<Link href="/products" />}`); `Dialog`'s close button uses
  `render={<Button variant="ghost" .../>}` (`dialog.tsx:65-71`); `Badge` uses Base
  UI's `useRender`/`mergeProps` directly (`badge.tsx:1-2,36-49`). There is no
  `asChild` anywhere in this codebase's primitives — don't reach for it from
  React-training-data muscle memory.
- **Server-safe primitives**: `Badge` (`badge.tsx`) and `Card`
  (`card.tsx`) carry **no** `"use client"` directive — safe to compose directly in
  Server Component pages, exactly as `products/page.tsx:6,29` and
  `checkout/page.tsx:9,38` already do.
- **Client-only primitives**: `Select`, `Dialog`, `DropdownMenu`, `Field` all start
  with `"use client"` (`select.tsx:1`, `dialog.tsx:1`, `dropdown-menu.tsx:1`,
  `field.tsx:1`) — they portal to `<body>` (Base UI `Portal` components) and need
  browser APIs (`ResizeObserver`, etc.).
- **`field.tsx` "broken React import" caveat — could not reproduce.** The file
  imports `import * as React from "react"` (`field.tsx:3`), which is a normal
  namespace import; `tsconfig.json` sets no `verbatimModuleSyntax`, so this compiles
  cleanly. It is already used successfully in six admin forms (`product-form.tsx`,
  `theme-form.tsx`, `store-name-form.tsx`, `currency-form.tsx`,
  `add-member-form.tsx`, `new-store-form.tsx` — confirmed via `grep`). Either the
  earlier bug was already fixed, or the note referred to a registry file never
  added here. Recommend a quick `pnpm typecheck` before the first storefront screen
  that newly imports `Field`, but don't block on the old caveat.
- **Tenant-theme portal marker is opt-in per overlay, not automatic.** `Select`'s
  popup explicitly stamps `{...{ [TENANT_THEME_PORTAL_ATTR]: "" }}`
  (`select.tsx:93`, sourced from `src/lib/theme.ts:51-54`) so the per-tenant accent
  reaches it after it portals out of `[data-tenant-theme]`. **`Dialog` does not
  self-stamp this anywhere in `dialog.tsx`**, and `DropdownMenu` doesn't either — the
  *consumer* is responsible, exactly as `account-menu.tsx:74-76` does by hand for its
  `DropdownMenuContent`. Any M6 screen introducing a `Dialog`/future `Sheet`/`Toast`
  in the storefront must stamp this marker itself or the accent silently reverts to
  the platform default inside that overlay.
- **Missing primitives** (not present anywhere in `src/components/ui/`, confirmed by
  `Glob`): `breadcrumb`, `skeleton`, `sheet`, `toast`/`sonner`, `accordion`, `tabs`,
  `avatar`, `tooltip`. Concretely:
  - **Breadcrumb** — the PDP already hand-rolls the idiom inline
    (`products/[slug]/page.tsx:62-73`, a `<nav aria-label="Breadcrumb">` with a
    `ChevronRight` separator). Worth promoting to a real primitive once a second
    screen wants it (account order detail's "Back to orders" link,
    `account/orders/[id]/page.tsx:85-91`, is a candidate to unify).
  - **Skeleton** — `product-grid-skeleton.tsx:1-22` hand-rolls `animate-pulse` divs;
    there is no shared `Skeleton` primitive to reuse elsewhere a loading state is
    needed (cart/checkout have none today — they're SSR'd with no client fetch, so
    may not need one).
  - **Sheet** — only relevant if the redesign wants a mobile nav drawer or a
    slide-over cart; today's header just wraps (`layout.tsx:47`, `flex-wrap`).
  - **Sonner/Toast, Accordion, Tabs, Avatar, Tooltip** — nothing in the current
    storefront code calls for these yet. Per DESIGN.md's restraint principle,
    recommend adding primitives **only** when a specific screen's canvas needs one,
    not speculatively.
- **Stripe Payment Element theming (verified against the installed `@stripe/stripe-js@9.14.0` types)** —
  `checkout-appearance.ts` builds an `Appearance` object by reading computed CSS
  custom properties off `[data-tenant-theme]` and converting OKLCH → sRGB
  (`oklchToSrgb`, `src/lib/color.ts`), because the Stripe iframe cannot read page CSS
  vars directly. Every variable it sets —
  `colorPrimary`/`colorBackground`/`colorText`/`colorDanger`/`colorTextSecondary`/
  `colorTextPlaceholder`/`inputColorBorder`/`borderRadius` — and the `theme:
  'stripe' | 'night'` values are confirmed present in the installed package's
  `Appearance`/`theme` types
  (`node_modules/.pnpm/@stripe+stripe-js@9.14.0/.../elements-group.d.ts:1185-1364`,
  specifically lines 1194, 1242-1258, 1351, 1364). This is a live API surface, not
  stale. **This file must not be touched for its logic**, only ever read from, by any
  M6 checkout work.

### Reference redesign conventions (PR #183 + M5's gallery) — the pattern to match

Extracted directly from `products/[slug]/page.tsx`, `purchase-panel.tsx`,
`product-gallery.tsx`:

- Page container: `mx-auto flex w-full max-w-6xl flex-col gap-10 px-6 py-10`
  (`page.tsx:60`); cart/checkout use a narrower `max-w-5xl`
  (`cart/page.tsx:41`, `checkout/page.tsx:57`) and account pages use `max-w-2xl`/
  `max-w-3xl` — there's already a **container-width-by-density** convention, not one
  fixed width; keep it (don't force everything to `max-w-6xl`).
- Breadcrumb idiom: `<nav aria-label="Breadcrumb">` + `ChevronRight` separator +
  `text-muted-foreground`/`hover:text-foreground` links, current page in
  `text-foreground font-medium truncate` (`page.tsx:62-73`).
- Chip radios for a bounded choice set: `role="radiogroup"` wrapper, each option a
  `<button role="radio" aria-checked>` with `border`/`bg-accent` selected state and
  `line-through opacity-60` disabled state (`purchase-panel.tsx:84-119`) — reuse this
  exact idiom for any future small enum picker (e.g. a shipping-method choice), never
  a native `<select>` for 2-4 options.
- Honest, static info-row list: a `<ul>` of `lucide` icon + short static copy, no
  fake per-product data (`page.tsx:114-128`) — matches DESIGN.md's "fake data that
  looks fake" anti-pattern warning.
- "Details" block: a hairline `<div className="bg-border h-px" />` divider + `<h2
  className="text-sm font-medium">` + `max-w-prose` body copy, rendered only when the
  data exists (`page.tsx:130-140`) — the pattern for any optional secondary content.
- **The panel's props/actions/states were kept 100% stable** across the redesign —
  `PurchasePanel` still takes the same `variants`/`currency` props and calls the same
  `addToCartAction` (`purchase-panel.tsx:8,54`); only the JSX/classes changed. This is
  *the* generalizable lesson for `CartItems`/`CheckoutForm` (see Risks).

### Current-state inventory — every remaining storefront screen

**A. Shared chrome** — `layout.tsx` (Server Component), `account-menu.tsx` (Client),
`search-form.tsx` (Server Component, no client JS).
- Primitives used: `Badge` (cart count, `layout.tsx:70-73`), `DropdownMenu*`
  (`account-menu.tsx`), `Input` + a native `<button>` styled with `buttonVariants`
  (`search-form.tsx:40-56`, deliberately not the `Button` component — see its doc
  comment on native-submit reliability).
- States: focus-visible on nav links/trigger (`account-menu.tsx:61`); no explicit
  hover treatment beyond `hover:text-foreground`; no loading/empty/error states
  (nothing async in the chrome itself, it's pure SSR).
- Functional-not-premium: header is a single flat row that wraps at narrow widths
  (`layout.tsx:47`, `flex-wrap`) rather than collapsing into a mobile menu; footer is
  one line of copyright with nothing else (`layout.tsx:95-99`); the cart-count
  `Badge` and sign-in link sit inline with the same visual weight as "Products" —
  little hierarchy between primary/secondary nav.

**B. Product listing** — `products/page.tsx` (Server, `force-dynamic`),
`product-grid-skeleton.tsx` (Server, pure markup).
- Primitives: `Card`/`CardContent` for the empty state (`page.tsx:29-40`); the grid
  itself is a bare `<ul>`/`<li>` of `ProductCard`.
- States: empty (`PackageX` icon + copy, `page.tsx:27-41`); loading (the skeleton,
  streamed via `<Suspense>`, `page.tsx:68-70`) — no error state (a thrown query
  surfaces to the nearest `error.tsx`, none exists at this route today).
- Functional-not-premium: header is just an `<h1>` + one line of muted copy
  (`page.tsx:61-66`) with no filter/sort affordance at all — acceptable for a small
  catalog, but reads plain next to the PDP's polish.

**C. Product card (already redesigned in M5 — mostly leave alone)** —
`product-card.tsx`, `product-image.tsx` (both Server Components).
- Already good: consistent `Card` sizing, `group-hover` lift + ring
  (`product-card.tsx:44`), `motion-safe:` guard on the hover transform (respects
  `prefers-reduced-motion`), truncated title with a `title` attribute fallback,
  "Sold out" `Badge` overlay, shared `ProductImageFrame` for the icon/`next/image`
  fallback logic (`product-image.tsx`). This is the bar the rest of M6 should match,
  not a target for rework.
- Only gap: no explicit focus-visible ring styling beyond the wrapping `<Link>`'s
  `focus-visible:ring-3` (`product-card.tsx:42`) — fine, already present.

**D. Search** — `search/page.tsx` (Server, `force-dynamic`).
- Primitives: `Card`/`CardContent` (three empty-ish states), `buttonVariants` for
  pagination links.
- States: **four** distinct empty/result states are already handled — no query
  (prompt + embedded `SearchForm`, `:72-88`), zero matches (`:89-101`), a page past
  the end (`:102-116`), and real results with pagination (`:117-151`) — this is
  already thorough per DESIGN.md's empty-state bar.
- Functional-not-premium: pagination is plain `Previous`/`Next` outline buttons with
  a "Page X of Y" caption (`:131-150`) — works, but is the least "designed" part of
  the screen; no page-number links.

**E. Cart** — `cart/page.tsx` (Server, `force-dynamic`), `cart-items.tsx` (Client).
- Primitives: `Card`/`CardHeader`/`CardContent`/`CardFooter` for the order-summary
  rail (`:113-152`), `Button` throughout (including the `render`-prop link pattern).
- States: empty (`:49-63`), a "some items were removed/adjusted" `role="status"`
  banner (`:67-86`), per-row pending (`isPending`, dimmed + `Loader2`,
  `cart-items.tsx:52-58,94-96`) and per-row error (`role="alert"`,
  `cart-items.tsx:73-77`) — solid coverage already.
- Functional-not-premium: the two-column `[1fr_20rem]` grid
  (`:65`) and the summary card are already close to "premium"; the weakest spot is
  the plain `divide-y` list of rows (`cart-items.tsx:20-27`) with no per-item
  thumbnail image — a cart row shows title/variant/price only, no photo, which reads
  thinner than the card/PDP now that real images exist.

**F. Checkout shell** — `checkout/page.tsx` (Server, `force-dynamic`),
`checkout-form.tsx` (Client, two-phase), `checkout-appearance.ts` (pure logic, do
not touch).
- Primitives: `Card` (form wrapper + summary), `Input`, `Label`, `Select` (country
  picker, `:285-322`), `Button`.
- States: empty cart (`:32-53`); phase-1 form validation is a client-side zod
  mirror with per-field `role="alert"` text (`checkout-form.tsx:136-146,216-224`);
  phase-2 payment step has its own pending/disabled/error handling
  (`:391-456`); a "cart changed since you last saw it" banner (`checkout/page.tsx:67-78`).
  Already dark-mode-aware for the embedded widget via a `matchMedia` subscription
  (`checkout-form.tsx:99-114`).
- Functional-not-premium: the two-phase form is plain stacked fields with no visual
  step indicator (nothing tells the shopper "step 1 of 2"); the order-summary card
  repeats cart's item list without images, same as cart.
- **Guardrail**: `checkout-appearance.ts` and the Payment Element's mount
  (`<PaymentElement />`, `checkout-form.tsx:432`) are Stripe-owned UI — restyle only
  the surrounding form chrome (labels, spacing, the "Continue to payment"/"Pay"
  buttons), never the Element's internals.

**G. Order confirmation** — `success/page.tsx` (Server, `force-dynamic`),
`checkout-complete.tsx` (Client, side-effect only, renders nothing).
- Primitives: `Card`/`CardContent`, a colored icon badge (`CircleCheck`/`Clock`/
  `CircleAlert` in a tinted circle, `:89-106`).
- States: **four-way** view derived from the verified PaymentIntent status —
  succeeded/processing/failed/invalid (`:56-80`) — already a thorough state machine
  for a confirmation page.
- Functional-not-premium: the four states share one generic card layout; "invalid"
  and "failed" get the same visual treatment as "succeeded" minus the item list,
  which slightly undersells the happy path (no confetti-tier moment, just a check
  icon) — a reasonable, restrained choice per DESIGN.md, but worth a deliberate call
  during `/design` rather than an accident.

**H. Account** — `account/page.tsx` (home), `account/orders/page.tsx` (list),
`account/orders/[id]/page.tsx` (detail) — all Server, `force-dynamic`, all gated by
`getShopperSession()` with a redirect-to-sign-in.
- Primitives: `Card` throughout; `Table`/`TableHeader`/`TableRow`/`TableCell` for the
  order list (`account/orders/page.tsx:110-154`) and the line-item table on the
  detail page (`account/orders/[id]/page.tsx:107-144`); `Badge` for order status,
  keyed off a shared `ORDER_STATUS_BADGE` map (`src/lib/validators/orders.ts`).
- States: empty ("No orders yet", `:74-91`), page-past-end (`:92-106`), populated +
  paginated. The detail page conditionally shows a "Shipping" card only when there's
  a shipment or tracking to show (`[id]/page.tsx:80`) — already a thoughtful
  conditional-empty pattern.
- Functional-not-premium: `account/page.tsx` is the thinnest screen in the whole
  storefront — one `<h1>`, one line of text, one `Card` with two buttons
  (`:36-67`); it reads like a stub next to the orders table. Good candidate for the
  most visible improvement in this milestone.
- **Guardrail** (soft-404): `[id]/page.tsx` deliberately has no `loading.tsx`/
  `<Suspense>` around its `notFound()` call (`:58-66` comment) — see Framework
  findings above. Don't add a route-level loading boundary here.

**I. Auth** — `account/sign-in/page.tsx`, `account/sign-up/page.tsx` (storefront
wrappers, Server) + shared `src/components/auth/sign-in-form.tsx`,
`sign-up-form.tsx` (Client, **shared with the platform's own `(auth)/sign-in`,
`(auth)/sign-up`**).
- Primitives: `Input`, `Label`, `Button` only — no `Field`/`FieldError` composite
  yet, errors are hand-rolled `<p role="alert">` (`sign-in-form.tsx:77-81`).
- States: `aria-invalid` per field on client-side zod failure, one form-level error
  message, `disabled` + `Loader2` while pending (`sign-in-form.tsx:82-85`) — no
  empty/loading-skeleton states apply here (it's a form, not a list).
- Functional-not-premium: both forms are the plainest UI in the storefront —
  stacked `Label`+`Input` pairs, no card/container framing beyond the page's own
  `max-w-sm` wrapper (`sign-in/page.tsx:41`), no password-visibility toggle, no
  "forgot password" (not implemented anywhere — out of scope to add, this is
  UI-only).
- **Guardrail — cross-surface shared component.** The storefront's sign-in page
  wraps `SignInForm` with its own heading "Welcome back"
  (`account/sign-in/page.tsx:43`), but the **platform** `(auth)/sign-in/page.tsx:26`
  wraps the *same* `SignInForm` under the heading "Sign in" — used by admin
  sign-in and store onboarding. Restyling the **page wrapper** (heading, copy,
  layout, card framing) is storefront-only and safe. Restyling the **form
  internals** (label text, button text, field layout inside `sign-in-form.tsx`/
  `sign-up-form.tsx`) changes both surfaces at once — see Risks for the exact E2E
  exposure.

**J. Landing/home `/`** — not part of `(storefront)` at all.
- `src/app/page.tsx` is the platform's apex marketing page (Server Component, no
  tenant context, no `(storefront)` layout/header/footer/theme) — a "Phase 0 ·
  foundations live" badge (`page.tsx:20-23`), a stack-tag list, and four CTAs to
  `/new`, `/products`, `/admin`, `/api/health` (`:45-76`).
- On a **tenant subdomain**, `/` never renders this page or any per-tenant landing
  page — `src/proxy.ts:59-66` 302-redirects a resolved tenant's `/` straight to
  `/products` ("A store host has no home page of its own yet — send its root to the
  catalog"). This is a deliberate, documented product decision, not a gap to fill
  silently.
- **Recommendation: out of scope for M6.** It isn't a `(storefront)` screen, GOAL.md's
  in-scope list doesn't mention it, and building a real per-tenant landing page would
  be a product/scope decision (new content, not just restyling), not a pure UI pass.
  The stale "Phase 0 · foundations live" badge is worth a one-line follow-up (it's
  now well past Phase 0), but as a separate tiny fix, not an M6 issue.

## Risks & unknowns

### Risk #1 (highest): breaking the E2E suite's selectors

The suite runs against a **production build** (`pnpm build && pnpm start`, never
`dev` — `playwright.config.ts` webServer + its own doc comment), single-worker,
`workers: 1`. Every spec below drives real accessible-name queries
(`getByRole`/`getByLabel`/`getByText`) against markup this milestone will touch.
Restyling classes/wrapper elements is safe; changing **text content, label
associations, or ARIA roles** is not.

- **`e2e/checkout.spec.ts`** (cart + checkout + PDP): `getByRole("button", { name:
  "Add to cart" })` (:76), `getByText("Added to cart")` (:78), `getByRole("button",
  { name: "Checkout" })` (:84), `getByLabel("Email")`/`"Full name"`/`"Address"`/
  `"City"`/`"State"`/`"ZIP code"` (:97-102, all `exact: true` except Email),
  `getByRole("button", { name: "Continue to payment" })` (:104), the Stripe iframe
  locator `iframe[src*="elements-inner-accessory-target"]` (:113-114, **not** ours to
  change, but the surrounding `<Elements>` mount point must stay intact),
  `getByRole("button", { name: /^Pay/ })` (:111,133), `getByRole("heading", { name:
  "Payment received" })` (:139, the success page's exact "succeeded" heading string
  — `success/page.tsx:69`).
- **`e2e/product-images.spec.ts`**: `getByRole("heading", { name: PRODUCT.title
  })` and `getByRole("img", { name: PRODUCT.title })` on the PDP/card (:68-72,
  113-125, depends on `ProductImageFrame`'s `alt` fallback,
  `product-image.tsx:51`); admin sign-in via the **same shared** `getByLabel("Email"
  )`/`"Password"` + `getByRole("button", { name: "Sign in" })` (:79-81).
- **`e2e/onboarding.spec.ts`**: goes through `/sign-up?redirect=/new` — the
  **platform** sign-up, not `/account/sign-up` — using `getByLabel("Name")`/
  `"Email"`/`"Password"` and `getByRole("button", { name: "Create account" })`
  (:73-76). These are `sign-up-form.tsx`'s labels/button text, so they resolve
  identically whichever page wraps the form.
- **`e2e/admin-auth.spec.ts`**: `getByRole("heading", { name: "Sign in" })` (:24, the
  **platform** `(auth)/sign-in` page's own heading — do not confuse with the
  storefront's "Welcome back"), `getByLabel("Email")`/`"Password"` +
  `getByRole("button", { name: "Sign in" })` (:35-37,68-70), `getByRole("button", {
  name: "Sign out" })` (:44,47,77).
- **`account-menu.test.tsx`** (Vitest DOM, not Playwright, but same exposure):
  depends on the literal text "My orders" (case-insensitive, :129), "Sign out"
  (:148,171), the name/email fallback text, and the `TENANT_THEME_PORTAL_ATTR`
  marker being present on the popup content (:139-141) — restyling
  `account-menu.tsx` must keep all four.

**The cross-cutting risk**: `SignInForm`/`SignUpForm` (`src/components/auth/*.tsx`)
are shared between the storefront's `/account/sign-in`+`/account/sign-up` (this
milestone's "Auth" screen) and the platform's `/sign-in`+`/sign-up` (exercised by
`admin-auth.spec.ts`, `onboarding.spec.ts`, and indirectly `product-images.spec.ts`).
**Mitigation**: restyle the two storefront *wrapper pages* freely (heading, copy,
card framing, `max-w-sm` container); if the form internals themselves need visual
changes, keep the exact label text ("Email", "Password", "Name") and button text
("Sign in", "Create account") stable, and run the full `pnpm build && pnpm
test:e2e` locally (all four specs, not just a storefront-looking subset) before
opening that PR.

### Risk #2: generalize the `purchase-panel` lesson to `CartItems`/`CheckoutForm`

PR #183 changed `PurchasePanel`'s markup/classes but kept its props
(`variants`/`currency`) and its call to `addToCartAction` byte-for-byte
(`purchase-panel.tsx:8,54`), which is exactly why checkout E2E stayed green through
that redesign. Apply the same discipline to:
- `cart-items.tsx` — keep the `CartItem[]` prop shape and the three Server Action
  calls (`updateQtyAction`, `removeFromCartAction`, both returning `{ ok, error? }`,
  `cart-items.tsx:9,37,45`) untouched; restyle the row markup only.
- `checkout-form.tsx` — keep `startCheckoutAction`'s input/output contract
  (`checkoutInputSchema`, `{ ok, clientSecret, totalCents, currency } | { ok:
  false, error }`) and the two-phase `started` state machine untouched; restyle the
  field layout/spacing only.

### Risk #3: Stripe Payment Element theming regression (silent, not a hard failure)

`checkout-appearance.ts` degrades gracefully — "a token that can't be read/parsed is
simply omitted" (`checkout-appearance.ts:27-29`) — so a regression here (e.g.
restructuring the `[data-tenant-theme]` wrapper, or removing the `--input`/
`--radius` tokens it reads) does **not** throw or fail a build/test; it just quietly
reverts the embedded card widget to Stripe's default blue-on-white/blue-on-night
preset. No automated test covers this. **Mitigation**: any checkout-shell PR must
manually click through the payment step in both light and dark OS scheme before
merge, per the existing UI-verification-loop practice.

### Risk #4: tenant-theme portal escape for any new overlay

Covered under Libraries above — restate as a risk: if a redesigned screen introduces
a `Dialog` (already available) or a future `Sheet`/`Toast` for e.g. a cart drawer or
a delete-confirmation, the developer must manually stamp
`{...{ [TENANT_THEME_PORTAL_ATTR]: "" }}` on its portaled content
(`src/lib/theme.ts:51`, pattern at `account-menu.tsx:74-76`) or a themed tenant's
accent silently drops to the platform default inside that one overlay. Nothing
enforces this automatically for `Dialog`/`DropdownMenu` today.

### Risk #5 / open unknown: `force-dynamic` on any new file

Every existing storefront page-level file declares `export const dynamic =
"force-dynamic"` because it reads the tenant/session/cart. If a screen restyle
splits a page into new files (e.g., extracting a new sub-component that itself
becomes a route, or adding a parallel/intercepted route for a modal), whoever adds
the new segment must remember this export or risk the exact DB-less-CI-prerender
failure the M5 handoff notes already hit once.

### Accessibility bar (DESIGN.md checklist) — current baseline is already decent

Labeled inputs, `aria-invalid`/`aria-describedby` wiring, `role="alert"`/
`role="status"` for errors/notices, and `focus-visible:ring-3` baked into the
`Button`/`Input`/`Select` primitives are already the norm across every screen read.
Two concrete gaps found:
- `product-grid-skeleton.tsx` has no `role="status"`/`aria-live`/`sr-only` "Loading
  products" text — a screen-reader user gets silence during the streamed fallback.
- `motion-safe:` is used exactly once today (`product-card.tsx:44`, the hover lift);
  worth confirming any new hover/transition micro-interaction added in M6 keeps the
  same `prefers-reduced-motion` guard rather than a bare `transition-*` class.

## Recommended approach

**Sequencing** (matches GOAL.md's own suggested order and dependency shape — chrome
first since every other screen renders inside it, card/listing already closest to
done, auth last because of its shared-component blast radius):

1. **Design-system prep** (one small shared issue, before screen work): add a
   `Skeleton` primitive (replacing the hand-rolled pulse divs) and consider
   promoting the PDP's inline breadcrumb into a `Breadcrumb` primitive, since at
   least two more screens (account order detail's back-link, and potentially cart/
   checkout) want the same idiom. Explicitly **defer** `Sheet`/`Toast`/`Accordion`/
   `Tabs`/`Avatar`/`Tooltip` until a specific screen's `/design` canvas calls for
   one — don't install unused primitives (DESIGN.md restraint principle).
2. **Shared chrome** — `layout.tsx` (header/footer), `account-menu.tsx`,
   `search-form.tsx`. Everything else renders inside this; get it right first.
   Resolve the mobile-nav-drawer-or-not question here.
3. **Product listing** — `products/page.tsx` + `product-grid-skeleton.tsx` (the card
   itself needs no rework, per Finding C).
4. **Search** — `search/page.tsx` (shares the grid/card, so mostly header +
   pagination polish once the listing pass lands).
5. **Cart** — `cart/page.tsx` + `cart-items.tsx`. Consider adding per-row thumbnails
   now that `ProductImageFrame` exists (Finding E's biggest gap).
6. **Checkout shell** — `checkout/page.tsx` + `checkout-form.tsx`. Manually verify
   the Payment Element in both color schemes before merging (Risk #3).
7. **Order confirmation** — `success/page.tsx` + `checkout-complete.tsx`.
8. **Account** — home, then orders list, then order detail (same order as the
   shopper's own navigation depth).
9. **Auth** — last, and coordinate the form-internals question from Risk #1 before
   starting; run the full E2E suite (all four specs), not just a storefront subset.

**`/design` → implementation mapping**, per the pre-pause PDP workflow and the
project's own UI-verification-loop practice: draft the canvas for the screen → user
edits/approves it → implement in-place in the real files (no new abstractions beyond
what the canvas needs) → `pnpm typecheck && pnpm lint && pnpm build` → keep the dev
server (or `pnpm start`) up and do a live click-through, including both color
schemes and, for any screen in Risk #1's list, the relevant E2E spec → open a small,
single-screen PR (PR #183 itself touched exactly two files — that's the size target).

## References

- `docs/milestones/M6-ui-redesign/GOAL.md`, `docs/DESIGN.md`,
  `docs/ARCHITECTURE.md:126-175` (M5 media section), `:259-262` (per-tenant theming
  decision).
- Next 16 docs (installed, `node_modules/next/dist/docs/01-app/`):
  `03-api-reference/04-functions/not-found.md`,
  `03-api-reference/03-file-conventions/loading.md`,
  `03-api-reference/02-components/image.md` (search "preload"/"priority"),
  `03-api-reference/03-file-conventions/02-route-segment-config/index.md` and
  `instant.md` (Cache Components — confirmed **not** enabled, `next.config.ts`).
- Stripe: installed `@stripe/stripe-js@9.14.0` types,
  `node_modules/.pnpm/@stripe+stripe-js@9.14.0/node_modules/@stripe/stripe-js/dist/stripe-js/elements-group.d.ts:1185-1364`
  (`Appearance`, `theme`, `variables`).
- shadcn/Base UI: `components.json` (`style: "base-nova"`), `package.json`
  (`@base-ui/react@^1.7.0`, `lucide-react@^1.37.0`), every file in
  `src/components/ui/`.
- E2E: `e2e/checkout.spec.ts`, `e2e/product-images.spec.ts`,
  `e2e/onboarding.spec.ts`, `e2e/admin-auth.spec.ts`, `playwright.config.ts`; DOM
  test `src/app/(storefront)/account/account-menu.test.tsx`.
- Reference redesign: PR #183 (`gh pr view 183`, files:
  `products/[slug]/page.tsx`, `purchase-panel.tsx`); PR #197/M5
  (`product-gallery.tsx`, `product-image.tsx`).
