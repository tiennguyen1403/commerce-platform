# Research — M7 Storefront v2

> Produced at milestone start (by the `researcher` agent). Read before building.
> **UI-only milestone**, same contract as M6: restyle presentation; never change data
> shapes, Server Actions, repository/service queries, tenant scoping, or Stripe internals.

## Context & goal

M6 restyled every storefront surface to one bar, but the bar **rose mid-milestone**: the
last two screens — auth (#214/PR #226) and the apex landing (#215/PR #230) — were built
from newer "Fable v2" canvases (accent stage, hero, richer composition), while the earlier
seven surfaces hold the M6 baseline (`docs/milestones/M6-ui-redesign/handoff.md:192-196`).
M7 raises those seven to the v2 bar, starting from the **already-designed, frozen PDP v2
canvas** (`docs/milestones/M7-storefront-v2/GOAL.md:8-18`).

State of the world, verified: GitHub Milestones 1–6 all exist and are closed
(`gh api "repos/:owner/:repo/milestones?state=all"`) — **no M7 milestone or issues yet**.
The latest issue is **#231**, the latest PR **#233** (`release: vM6`), so M7 issues number
from ~#234. The roadmap row already reads `| M7 | storefront-v2 | active |`
(`docs/milestones/README.md:60`). One open dependabot PR (**#228**) bumps `next`
16.3.3 → 16.3.4, `lucide-react` 1.37 → 1.40, `@stripe/stripe-js` 9.14 → 9.15 and five more —
every version claim below is against the **installed** tree (`package.json`,
`node_modules`), which is what M7 builds on unless #228 merges first.

## Key questions

1. What does "v2" consist of **in code**, concretely enough that one design canvas and
   nine issues can cite a single vocabulary? (§A)
2. The PDP v2 canvas shows content beyond today's schema (reviews, a Color axis, XS–XXL,
   a delivery estimate, accordions, related products). Which parts are UI-only-feasible,
   which are honest static copy, which need data → out of scope? (§C)
3. Fullscreen viewer for gallery B: dependency or hand-rolled? (§D)
4. Sticky desktop buy box and sticky mobile buy bar — CSS-only or client JS? (§E)
5. Chrome-first or PDP-first? The PDP canvas was drawn **inside the shipped chrome**.
   (§Recommended approach)
6. Is a shared `SectionPanel` worth extracting now that M7 touches all three copies? (§G)
7. What must not break — E2E selectors, client contracts, `force-dynamic`, the soft-404
   posture, Payment Element theming? (§Preserved selectors, §Risks)

## Findings

### A. The "v2 vocabulary" — what the two v2 surfaces do that the seven baseline ones don't

Diffed `src/app/page.tsx`, `src/app/landing-stage.tsx`,
`src/app/(storefront)/account/auth-stage.tsx` and `.../account/sign-in/page.tsx` against the
baseline screens. Every item below is a class string that **already ships**; this is the
list the design canvas and each screen issue should reference by number.

- **V1 · Display type.** v2: `text-4xl … sm:text-5xl` h1 (`page.tsx:153`),
  `text-2xl … sm:text-3xl` section h2 (`page.tsx:196,298`), `text-2xl … lg:text-4xl` stage
  line (`auth-stage.tsx:29`). Baseline: a flat `text-3xl` h1 on every screen
  (`products/page.tsx:75`, `search/page.tsx:71`, `cart/page.tsx:43`,
  `checkout/page.tsx:44,74`, `products/[slug]/page.tsx:103`, `success/page.tsx:137`) and
  `text-2xl` across the account cluster.
- **V2 · Text wrapping.** v2 uses `text-balance` on h1 and `text-pretty` on body/headline
  (`page.tsx:153,157,196`; `auth-stage.tsx:29,32`). Baseline: only `success/page.tsx:137`.
- **V3 · Accent stage / band.** `bg-accent` + `rounded-2xl` + generous padding:
  `lg:rounded-2xl lg:p-12` (`auth-stage.tsx:26`), `rounded-2xl p-6 sm:p-8 lg:px-12 lg:py-10`
  (`page.tsx:294`), `rounded-2xl p-4 sm:p-6` (`landing-stage.tsx:62`). Baseline has no
  accent surface bigger than the size-9 chip and its radius caps at `rounded-xl`.
- **V4 · `accent-foreground` pairing.** Secondary copy on the tint is
  `text-accent-foreground`, never `text-muted-foreground` — the muted grey only reaches
  ~4.25:1 on the tint (`auth-stage.tsx:11-12,32,54,80`; `page.tsx:302`). No baseline
  equivalent, because no baseline screen has a tinted surface.
- **V5 · Two-column stage grid.** `lg:grid-cols-[minmax(0,1fr)_400px] lg:items-center
lg:gap-16` (`sign-in/page.tsx:59`), `lg:grid-cols-[minmax(0,1fr)_568px] … lg:gap-16`
  (`page.tsx:140`). It splits at **`lg`**, not `md` — at `md` the stage would get a ~160px
  measure (`auth-stage.tsx:16-19`). Baseline splits are `md:grid-cols-2` on the PDP
  (`products/[slug]/page.tsx:78`) and `lg:grid-cols-[1fr_20rem]` on cart/checkout
  (`cart/page.tsx:68`, `checkout/page.tsx:80`).
- **V6 · Eyebrow.** `text-primary text-xs font-medium tracking-wide uppercase`
  (`page.tsx:191`). No baseline equivalent.
- **V7 · Status / meta chip.** An outline pill with an accent dot:
  `border-border text-muted-foreground … rounded-full border px-3 py-1 text-xs font-medium`
  plus `bg-primary size-1.5 rounded-full` (`page.tsx:144-149`). Baseline uses `Badge` only.
- **V8 · Accent icon chip.** `bg-accent text-primary flex size-9 … rounded-lg` with an
  `Icon size-5` — now on eight surfaces (`page.tsx:207`, `sign-in/page.tsx:65`, all three
  `SectionPanel` copies) and inverted to a white chip on the tint,
  `bg-card ring-foreground/10` (`auth-stage.tsx:75`). This one **already is** shared
  vocabulary; the v2 move is to use it on surfaces that currently have no chip.
- **V9 · Elevation.** `shadow-lg` plus `ring-foreground/10 ring-1` on a lifted surface
  (`landing-stage.tsx:106`; also `sheet.tsx:55`). Baseline: `shadow-sm` on card hover only
  (`product-card.tsx:44`); everything else is flat.
- **V10 · Image aspect.** The landing miniature's product tiles are **square**
  (`landing-stage.tsx:161`), and the frozen canvas's own related-products card is
  `aspect-ratio:1 / 1` (canvas `build.mjs:468`) — only the **PDP cover** is 4:5. Baseline is
  `aspect-square` everywhere (`product-card.tsx:45`, `product-gallery.tsx:31,52`,
  `cart-items.tsx:69`). **This answers the consistency question: cards stay square.**
- **V11 · Container padding.** v2 uses `max-w-6xl px-4 md:px-6` (`page.tsx:113,140,188`) — a
  narrower gutter on phones. Every storefront page uses a flat `px-6`.
- **V12 · Section rhythm.** `py-12 lg:py-16` / `pb-16 lg:pb-20`, inner `gap-6 lg:gap-7`
  (`page.tsx:140,188,292`). Baseline is a flat `py-10` + `gap-8`.
- **V13 · Chip list.** `bg-secondary text-secondary-foreground rounded-md px-2.5 py-1
text-sm` (`page.tsx:281`). No baseline equivalent.
- **V14 · Motion.** Neither v2 surface added any. The whole storefront has exactly one
  `motion-safe:` guard (`product-card.tsx:44`); everything else is
  `transition-colors`/`transition-all`. Any new micro-interaction M7 adds must carry the
  same guard (DESIGN.md:15).

**Container-width-by-density stays** (M6 `GOAL.md:46-48`): `max-w-6xl` listing/PDP/landing,
`max-w-5xl` cart/checkout, `max-w-3xl` orders, `max-w-2xl` account home, `max-w-lg`
confirmation. V11/V12 change _padding and rhythm_, not widths.

### B. Framework / APIs — Next 16.3.3, React 19.2.8, Playwright 1.62.1

- **`force-dynamic` is live.** `next.config.ts` sets no `cacheComponents` flag (it holds
  only `allowedDevOrigins` and `images.remotePatterns`), so route-segment config is not
  removed. Every storefront page keeps `export const dynamic = "force-dynamic"`
  (`products/page.tsx:13`, `search/page.tsx:24`, `cart/page.tsx:28`, `checkout/page.tsx:28`,
  `checkout/success/page.tsx:27`, `account/page.tsx:13`, `account/orders/page.tsx:31`,
  `account/orders/[id]/page.tsx:41`, `account/sign-in/page.tsx:22`, `account/sign-up`). The
  PDP is a dynamic segment and needs none. **Any new page-level file M7 adds must carry
  it**, or the DB-less CI build fails at prerender.
- **`notFound()` soft-404 is doc-confirmed and still a trap** —
  `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/not-found.md:80-122`
  ("Calling `notFound()` after streaming has started"). `account/orders/[id]/page.tsx:65-70`
  states in a comment that it awaits the read directly so `notFound()` yields a real 404;
  the PDP does the same (`products/[slug]/page.tsx:56`, with `not-found.tsx` beside it).
  **Do not add `loading.tsx` under `/products/[slug]` or `/account/orders/[id]`.** The
  component-local `<Suspense>` pattern (`products/page.tsx:81-83` plus
  `product-grid-skeleton.tsx`) is the sanctioned alternative.
- **`next/image`: `preload`, never `priority`** —
  `.../02-components/image.md:291-293` ("deprecated in favor of `preload`") and the v16.0.0
  changelog row at `:1404`. Already correct at `product-image.tsx:57`. Keep exactly one
  preloaded LCP image per page.
- **`next/dynamic` still exists** (`01-app/02-guides/lazy-loading.md:22-34`) and `ssr:false`
  is legal **only inside a Client Component** (`:95` — "`ssr: false` is not allowed with
  `next/dynamic` in Server Components"). A lazily-loaded viewer must therefore be imported
  from inside the client gallery, never from the Server page.
- **Package CSS imports are supported anywhere under `app/`**
  (`01-app/01-getting-started/11-css.md:314-348`) and **ordering follows import order**
  (`:400-451`). See Risk #6.
- **The root layout exports no `viewport`** (`src/app/layout.tsx` has `metadata` only), so
  the default meta is `width=device-width, initial-scale=1` — **no `viewport-fit=cover`**,
  which means `env(safe-area-inset-bottom)` resolves to `0` on iOS. `viewportFit` is
  available in Next 16's `Viewport` type
  (`node_modules/next/dist/lib/metadata/types/extra-types.d.ts:52`), but adding it in the
  root layout also touches admin and auth. See §E and Risk #8.
- **Playwright.** `devices["Desktop Chrome"]` is **1280×720, `isMobile:false`,
  `hasTouch:false`** (read out of `playwright-core@1.62.1/lib/coreBundle.js`), so both `md:`
  (768px) and `lg:` (1024px) match in every spec — a `md:hidden`/`lg:hidden` mobile bar is
  `display:none` and therefore invisible to role queries. The runner is **strict**: the
  string "strict mode violation: … resolved to N elements" lives in `coreBundle.js`, and
  `isElementHiddenForAria` confirms role queries skip a11y-hidden nodes. Both facts are
  load-bearing for the gallery rebuild (Risk #1a). `hasTouch:false` also means **no spec can
  drive a swipe** — the carousel must stay fully operable with arrows and the keyboard.
- **Tailwind v4.3.3** declares `@layer theme, base, components, utilities;` and puts
  `@tailwind utilities` inside `@layer utilities` (`node_modules/tailwindcss/index.css:1`).
  **Unlayered third-party CSS therefore outranks every Tailwind utility** — the single most
  important fact about importing a lightbox stylesheet (Risk #6).
- Storefront dark mode is `@media (prefers-color-scheme: dark)` on `:root` only
  (`src/app/globals.css:91-124`); the per-tenant accent is re-parametrized under
  `[data-tenant-theme]` (`layout.tsx:64-65`, `src/lib/theme.ts:28-32`). There is no `.dark`
  class, so a body-portaled overlay inherits the light/dark tokens fine but **not** the
  tenant accent unless it stamps `TENANT_THEME_PORTAL_ATTR` (`src/lib/theme.ts:35-51`).

### C. The frozen PDP v2 canvas — what it asks for, and what today's data supports

Canvas read at the `/design` scratchpad (`pdp-v2/canvas.json`, `build.mjs`,
`final.part.mjs`). FINAL is page 1, "Direction A layout + gallery B". Its own brief
annotation (`canvas.json:169`) already separates DB-backed from fabricated content; this
section turns that into a build/defer decision. Anything landed as (b) must be recorded in
`GOAL.md` → Exceptions, the way M6 recorded the cart thumbnail and the "Coming soon" auth
affordances.

**Gallery B, exactly as specified** (`final.part.mjs:6-31`):

- one **4:5** cover; round `Previous image` / `Next image` buttons, an
  `Open fullscreen viewer` button (`maximize-2`), and a `k / N` tabular-nums counter pill —
  arrows and counter only when `images.length > 1`;
- a thumbnail rail beneath: `grid-template-columns: repeat(max(6, N), …)`, `gap:8px`, each
  thumb `aspect-ratio:1/1`, `aria-label="Show image ${i + 1}"` and `aria-current="true"` on
  the active one — **byte-identical to the shipped rail's labels**
  (`product-gallery.tsx:41-56`); a single image gets no rail and no arrows, which is exactly
  today's behaviour;
- `MAX_IMAGES_PER_PRODUCT = 8` (`src/lib/validators/catalog.ts:198`) is precisely why
  `max(6, N)` keeps the rail on one row;
- the viewer: `role="dialog" aria-modal="true" aria-label="Image viewer"`, a counter, a
  zoom-percent pill, `Play slideshow` / `Zoom out` / `Zoom in` / `Close`, arrows,
  thumbnails, Esc to close;
- mobile: a swipe carousel with `k / N` and one dot per image, plus a sticky buy bar with a
  44px CTA that appears only once the main CTA scrolls out of view (`canvas.json:177`,
  `build.mjs:310-320,487-492`).

**Classification of the canvas's beyond-schema content:**

- **(a) UI-only, build it** — the 4:5 cover, arrows, expand button, counter, rail and viewer
  (all read `product.images`, already loaded at `products/[slug]/page.tsx:81-89`); the
  sticky desktop buy box (pure CSS — the cart already ships the recipe,
  `cart/page.tsx:68,116`); the sticky mobile bar (a little client JS, §E).
- **(a) UI-only and contract-compatible — the quantity stepper.**
  `addToCartAction(variantId, qty?)` already takes an optional qty (`cart/actions.ts:27-30`)
  and `addToCartInputSchema` is `{ variantId, qty: z.int().min(1).max(MAX_CART_QTY)
.default(1) }` with `MAX_CART_QTY = 99` (`src/lib/cart.ts:19,39-42`). `PurchasePanel`
  calls `addToCartAction(variantId)` today (`purchase-panel.tsx:54`); passing a second
  argument needs **no** action, schema or service change. **Caveat:** "add" means
  _increment_ — the action folds the request into any existing line (`cart/actions.ts:46`)
  and the service clamps the total to live stock, so a stepper set to 3 on a cart already
  holding 2 yields 5 (clamped). Cap the stepper at `Math.min(available, MAX_CART_QTY)`, the
  way `cart-items.tsx:51` does.
- **(a) for "Details", (b) or cut for the rest — the accordions.** "Details" renders the
  real `product.description` (`products/[slug]/page.tsx:133-143`). Materials & care /
  Size & fit / Shipping & returns have no data; they are only defensible as **honest,
  store-level static copy** in the register of the existing trust list (`:118-131`).
  DESIGN.md:58 rejects "fake data that looks fake".
- **(b) or (c) — the delivery estimate.** "Arrives Sep 15 – 19" is **(c) out of scope** as a
  computed date (no lead-time data anywhere in the schema); the existing static "Made to
  order by our print partner" line is the honest **(b)** version.
- **(b) or (c) — the size-guide link.** Only **(b)** if it points somewhere real; otherwise
  cut, or use the M6-09 disabled "coming soon" precedent (M6 `GOAL.md:96-105`).
- **(c) out of scope — the star rating, review count, review list, rating bars and "Write a
  review".** There is no `Review` model; this is a feature, not a restyle.
- **(c) out of scope — the Color axis and swatches.** `ProductVariant` carries a single flat
  `name` (`purchase-panel.tsx:12-18`), rendered as one chip radiogroup at `:81-120`. A
  Color × Size split needs a variant-options model. Keep the single "Variant" radiogroup.
- **(c) — the fixed XS–XXL size set.** Render whatever variants exist; the seed's variant
  names already read as sizes.
- **(c) out of scope — the related-products rail.** It is a second catalog query, and M6's
  `GOAL.md:64-67` already names "no related-products rail" as out of scope.

**Seed reality check for verification.** Only `classic-tee` (2 images, 1200×1200) and
`everyday-hoodie` (1 image, 1000×1250) carry photos (`prisma/seed.ts:182-205`). So (i) a 4:5
cover **crops roughly 20%** off the square `classic-tee` shots — crop vs. letterbox is a
`/design` decision, not an accident; and (ii) nothing in the seed exercises the 3–8-image
rail, so that ladder must be verified by uploading through the admin image manager.

### D. Fullscreen viewer options for gallery B — fresh lookups (2026-09-08)

- **`yet-another-react-lightbox` 3.32.2**, MIT, published 2026-07-30; **zero runtime
  dependencies**; peer range includes React 19; repo pushed 2026-09-07 with 2 open issues
  and 1.3k stars. Measured gzip of the published ESM: core 16.7 KB, zoom 6.4, thumbnails
  3.9, fullscreen 1.8, slideshow 1.5, counter 0.5 — about **31 KB JS** plus ~2.7 KB CSS for
  the plugin set the canvas needs.
- **`photoswipe` 5.4.4**, MIT, zero deps, 1.2 MB unpacked. Vanilla: needs a third-party
  React wrapper plus imperative DOM wiring — more integration surface for the same result.
- **`react-photo-view` 1.2.7**, Apache-2.0, zero deps, 377 KB unpacked. Viable, but no
  slideshow/counter plugins and a smaller community.
- **`lightgallery` 2.9.0**, **GPLv3** or paid. **Rejected on licence** for a non-GPL
  portfolio repo.
- **shadcn `carousel` (base-nova)** exists in the registry (HTTP 200 at
  `ui.shadcn.com/r/styles/base-nova/carousel.json`) but pulls **`embla-carousel-react`
  8.6.0** (MIT, plus 2 transitive packages). It solves only the mobile swipe carousel, not
  the viewer. Base UI ships **no** carousel at all (§F).
- **Hand-rolled on the installed Base UI `Dialog`.** `DialogRoot.modal` defaults to `true`
  and documents "focus is trapped, document page scroll is locked"
  (`node_modules/@base-ui/react/dialog/root/DialogRoot.d.ts:26-34`), and `escapeKey` is a
  close reason (`:81`). So Esc, focus trap, scroll lock and the portal come free. Zoom and
  pan, pinch, swipe, slideshow and adjacent-slide preloading do **not**.

**Recommendation: `yet-another-react-lightbox`**, loaded via `next/dynamic` from inside the
client gallery, with the Zoom / Thumbnails / Slideshow / Counter plugins (skip `Fullscreen`
— the Fullscreen API adds a browser-chrome mode the canvas never draws). Weighed against
CLAUDE.md's "don't add heavy dependencies without noting why" and DESIGN.md's restraint:

- The frozen canvas **specifies** zoom (double-click / scroll / pinch), drag-to-pan,
  slideshow, swipe and thumbnails (`canvas.json:185,193`). Hand-rolling pinch-zoom plus pan
  plus momentum swipe correctly (pointer events, `touch-action`, wheel, reduced motion) is
  several hundred lines of the least-testable code in the repo — well past "restraint".
- ~31 KB gz is bounded and **deferred**: `next/dynamic` keeps it out of the initial PDP
  bundle (the library's own Next.js guidance), so the LCP path is unchanged. For
  calibration, M3's decision log rejected Recharts at "~50KB for two small charts"
  (`docs/ARCHITECTURE.md:280-282`) — this is smaller and buys much more.
- Zero runtime dependencies, MIT, a React 19 peer range, actively maintained.
- It is **token-friendly**: everything is `--yarl__*` custom properties with fallbacks
  (`--yarl__color_backdrop`, `--yarl__color_button`, `--yarl__portal_zindex`, …). Unlike the
  Stripe Payment Element it is **not in an iframe**, so our native `oklch()` tokens can be
  assigned straight through — **no `src/lib/color.ts` conversion needed**. That trap is
  Stripe-specific (`checkout-appearance.ts`).
- It solves the tenant-accent portal problem cleanly: `PortalSettings` exposes both `root`
  (a mount point) and `container` (HTML attributes for the portal div), per its
  `dist/types.d.ts:265-271`. Either mount `root` inside the `[data-tenant-theme]` wrapper
  (the portal is `position:fixed`, so nesting is safe) or stamp `TENANT_THEME_PORTAL_ATTR`
  through `container`. **Typing note:** `container` is `React.HTMLAttributes<HTMLDivElement>`,
  which does not admit a bare `data-*` key in an object literal, so `root` is the
  lower-friction route.
- Accessible names are configurable via `labels` (`Previous` / `Next` / `Close` / …,
  `types.d.ts:386-398`) — needed for Risk #1 and the M6-09 `getByLabel` substring trap.
- **The Zoom + `next/image` caveat does not bite us.** The library's Next.js example warns
  that the Zoom plugin does not compose with `render.slide` + `next/image` (it wants an
  explicit `srcSet` built against `/_next/image`). Every stored URL today is root-relative
  and therefore rendered `unoptimized` (`isUnoptimizedImageSrc`,
  `src/lib/validators/catalog.ts:282-284`), so plain `<img src>` slides are already the
  optimizer-free path the PDP uses. Feed the viewer plain `{ src, alt, width, height }`
  slides — the stored `width`/`height` live on `ProductImage`, so `ProductGallery`'s
  deliberately minimal client shape (`product-gallery.tsx:9`) would gain two display-only
  fields. That is a **client prop-shape change**: keep it inside the gallery's own type and
  name it in `GOAL.md`.

**Fallback if the dependency is refused at planning:** a Base UI `Dialog` viewer with
arrows, counter, thumbnails and Esc, and **no** zoom or slideshow. Honest, still well above
today's bar; the canvas note would need amending to match.

**Mobile swipe carousel: do not add Embla for it.** A CSS
`overflow-x-auto snap-x snap-mandatory` track with `scroll-snap-align:center` gives swipe
plus dots with no JS beyond a scroll or `IntersectionObserver` listener for the `k / N`
counter, and degrades to the arrows on desktop. Adding `embla-carousel-react` (plus two
transitive packages) for one screen fails the restraint test when the viewer already ships
a carousel of its own.

### E. Sticky buy box (desktop) and sticky buy bar (mobile)

- **Desktop sticky is CSS-only and already proven in this layout.** The chrome is
  `<div data-tenant-theme class="flex min-h-dvh flex-col">` → a non-sticky `<header>` →
  `<main class="flex-1">` (`layout.tsx:64,66,129`); no ancestor sets `overflow`, so
  `position: sticky` works. The cart ships the exact recipe — `lg:items-start` on the grid
  plus `lg:sticky lg:top-6` on the grid child (`cart/page.tsx:68,116`) — and checkout uses
  the same grid (`checkout/page.tsx:80`). The canvas asks for `position:sticky; top:24px` on
  the buy column inside `grid-template-columns: 7fr 5fr; align-items:start`
  (`final.part.mjs:36-38`, `build.mjs:364`): the identical pattern. **The header is not
  sticky today**, so `top-6` needs no header-height offset — if M7 makes it sticky, every
  sticky offset on the PDP _and_ on cart/checkout must move together (Risk #9).
- **The mobile bottom bar needs a little client JS.** "Appears only once the main
  Add-to-cart scrolls out of view" (`canvas.json:177`) is an `IntersectionObserver` on the
  primary CTA, which already lives inside the client `PurchasePanel` — no new client
  boundary. A CSS-only always-on bar is simpler but permanently covers content and reads
  worse.
- **Safe-area insets are currently inert.** `env(safe-area-inset-bottom)` requires
  `viewport-fit=cover`, which the app does not emit (§B). Two options: (i) add
  `export const viewport: Viewport = { viewportFit: "cover" }` to the **root** layout — a
  cross-surface change that also affects admin and auth, so it needs an explicit call; or
  (ii) write `pb-[max(1rem,env(safe-area-inset-bottom))]`, which degrades to `1rem` today
  and starts working for free if (i) ever lands. **Recommend (ii)** for a UI-only pass.
- **Don't let the bar cover the footer**: `fixed inset-x-0 bottom-0` plus a spacer of the
  bar's height at the end of the PDP, or bottom padding on the page container under `md`.
- Base UI ships `unstable-use-media-query`
  (`node_modules/@base-ui/react/unstable-use-media-query/index.d.ts`) if a JS breakpoint is
  ever needed, but its `options` argument is **required** (not optional) and it documents a
  double-pass SSR render. Prefer Tailwind's `md:hidden` — it also keeps the bar out of the
  a11y tree at the E2E viewport (§B, Risk #1a).

### F. Primitives inventory — Base UI 1.7.0 and shadcn base-nova

`@base-ui/react@1.7.0` exports, straight from its `package.json`: `accordion`,
`alert-dialog`, `autocomplete`, `avatar`, `button`, `checkbox`, `checkbox-group`,
`collapsible`, `combobox`, `context-menu`, `dialog`, **`drawer`**, `field`, `fieldset`,
`form`, `input`, `menu`, `menubar`, `meter`, `navigation-menu`, **`number-field`**,
`otp-field`, `popover`, `preview-card`, `progress`, `radio`, `radio-group`, `scroll-area`,
`select`, `separator`, `slider`, `switch`, `tabs`, `toast`, `toggle`, `toggle-group`,
`toolbar`, `tooltip`, `merge-props`, `use-render`, `unstable-use-media-query`. **No
carousel, no lightbox.**

shadcn base-nova registry probe (HTTP status against
`ui.shadcn.com/r/styles/base-nova/<name>.json`): `carousel` **200** (dependency
`embla-carousel-react`), `accordion` **200** (dependency: `cn` only), `tabs` **200**,
`tooltip` **200**, `avatar` **200**, `toggle-group` **200**, `scroll-area` **200**,
`number-field` **404**.

Already in `src/components/ui/`: `badge`, `breadcrumb`, `button`, `card`, `dialog`,
`dropdown-menu`, `field`, `input`, `label`, `select`, `separator`, `sheet`, `skeleton`,
`table`, `textarea`.

Notes that matter for M7:

- Base UI parts self-declare `'use client'` (`accordion/root/AccordionRoot.js:2`,
  `number-field/root/NumberFieldRoot.js:2`, `dialog/root/DialogRoot.js:2`), which is why the
  registry's `accordion.tsx` carries **no** `"use client"` — it can be composed straight
  from a Server Component page. This repo's `dialog.tsx`/`sheet.tsx` do declare it.
- The house style is the `render` prop, never `asChild`; server-safe wrappers use
  `useRender` + `mergeProps` (`skeleton.tsx:1-2`, `breadcrumb.tsx:3-4`, `badge.tsx:1-2`).
- `DialogContent` is **not** fullscreen-shaped: it hardcodes
  `fixed top-1/2 left-1/2 … sm:max-w-sm` (`dialog.tsx:56`) and does **not** stamp
  `TENANT_THEME_PORTAL_ATTR`. A hand-rolled viewer needs its own popup wrapper, not
  `DialogContent`.
- **Accordion is the one primitive M7 plausibly needs** (the PDP Details block) and it
  exists ready-made. Add it only if the canvas keeps the accordions (§C).
- **Do not add `number-field` for the quantity stepper**: it is 404 in base-nova, and the
  cart already ships the exact idiom — two `Button size="icon-sm"` with
  `aria-label="Decrease quantity"` / `"Increase quantity"` around an `aria-live="polite"`
  readout (`cart-items.tsx:101-130`). Reusing that markup on the PDP buys consistency free.
- Button sizes are dense in base-nova: `default` `h-8`, `lg` `h-9`, `icon` `size-8`
  (`button.tsx:23-33`). The PDP's `h-12` CTA and the variant chips' `h-10` are explicit
  overrides (`purchase-panel.tsx:131,104`), and the canvas's "h-8 chrome / h-10 pills /
  h-12 CTA" ladder matches what already ships.

### G. `SectionPanel` — three copies, and whether to extract

Three near-identical local definitions: `checkout/checkout-form.tsx:378-415` (inside a
client component), `checkout/success/page.tsx:268-305` (server) and
`account/section-panel.tsx:21-60` (server, already shared by two account pages). They differ
in exactly two ways: the generated heading-id prefix (`checkout-` / `confirm-` / `account-`)
and whether `description` is optional. Everything else is identical — `Card` >
`CardContent role="group" aria-labelledby` > the `bg-accent text-primary size-9 rounded-lg`
chip > an `h2 text-base font-semibold`. Call sites: `checkout-form.tsx:195,223,254`;
`success/page.tsx:153,188`; `account/page.tsx:52,68`; `account/orders/[id]/page.tsx:169,229`.

M6 deliberately deferred extraction after only three call sites
(`docs/ARCHITECTURE.md:378-381`). M7 touches all three screens **and** raises the panel
idiom itself (V3/V9), so extracting once, first, avoids editing the same shell three times.

**Recommendation:** extract to `src/components/ui/section-panel.tsx`, server-safe (no
`"use client"` — it must stay importable both from `checkout-form.tsx`, which _is_ a client
component, and from three Server Components), taking an `idPrefix` so the generated ids stay
exactly what they are today and two panels sharing a title on one page can't collide. Ship
it in the design-system prep issue as a visual no-op, before any screen work — the same
shape as M6-01 (`Skeleton` + `Breadcrumb`, PR #217).

### H. Current-state inventory — the seven baseline screens

Each entry: what ships, the gap to the v2 vocabulary, and the contracts that must stay
byte-identical.

**H1. Shared chrome** — `layout.tsx` (Server), `mobile-nav.tsx` and
`account/account-menu.tsx` (Client), `nav-link.tsx` (Client), `store-brand.tsx`,
`search/search-form.tsx` (Server, no client JS).

- Ships: a nav-left / utilities-right desktop row (`layout.tsx:70-100`), a mobile row with
  the `Sheet` drawer (`:104-126`; portal stamped at `mobile-nav.tsx:81`), a three-column
  footer plus a bottom bar (`:131-185`). The header is **`border-b`, not sticky** (`:66`).
- Gap to v2: no V11 `px-4 md:px-6` (flat `px-6`); the footer carries no V3/V8 idiom; no
  `text-pretty`; no elevation-on-scroll treatment.
- Must hold: the `[data-tenant-theme]` wrapper and injected `<style>` (`:64-65`); the
  tenant / session / cart reads; `cartLabel` (`:58`), an `aria-label` the drawer repeats
  (`mobile-nav.tsx:114`); the drawer's `TENANT_THEME_PORTAL_ATTR`; the account menu's "My
  orders" link and "Sign out" button (`account-menu.test.tsx:132,151,174`).

**H2. Product listing** — `products/page.tsx` (Server, `force-dynamic`),
`product-card.tsx`, `product-grid-skeleton.tsx`.

- Ships: header plus a count toolbar on a hairline (`:50-54`), the tinted-circle empty state
  (`:29-42`), a 1/2/3-column grid, a component-local `<Suspense>` (`:81-83`) and
  `preload` on the first card only (`:62`).
- Gap to v2: `text-3xl` flat header, no eyebrow, no `text-pretty`, flat `py-10`.
- Must hold: `force-dynamic` (`:13`); **no route-level `loading.tsx`** (the comment at
  `:20-22` says why); the skeleton's toolbar mirroring plus its `role="status"` /
  `aria-live="polite"` / `sr-only` "Loading products"; `ProductCard`'s square frame (V10)
  and the alt-falls-back-to-title rule (`product-image.tsx:51`) that `product-images.spec.ts`
  keys on.

**H3. PDP** — `products/[slug]/page.tsx` (Server), `purchase-panel.tsx` (Client),
`product-gallery.tsx` (Client), `not-found.tsx`.

- Ships: a `Breadcrumb` (`:64-76`), a `md:grid-cols-2` split (`:78`), a square gallery with
  a `grid-cols-5 sm:grid-cols-6` rail (`product-gallery.tsx:31,41`), title + price + variant
  chips + CTA, a static trust list (`:118-131`) and an optional Details block (`:133-143`).
- Gap to v2: the whole canvas — 4:5 cover, viewer, sticky buy box, mobile bar, richer
  hierarchy, quantity.
- Must hold: `PurchasePanel`'s props `{ variants, currency }` and its call shape
  (`purchase-panel.tsx:27-33,54`), where a `qty` second argument is the only sanctioned
  extension (§C); the "Add to cart" button text and the "Added to cart" status line
  (`:134,142`); `notFound()` non-streamed (`page.tsx:56`); the image-less placeholder branch
  (`:90-99`) that keeps `getByRole("img", …)` at zero.

**H4. Search** — `search/page.tsx` (Server, `force-dynamic`).

- Ships: a query-echo header (`:70-87`), four distinct states (`:89-144`), the listing's
  count toolbar (`:152-156`) and a windowed numbered pager (`:170-221`, `paginationRange`
  from `src/lib/pagination.ts`).
- Gap to v2: same as H2 — flat header, no eyebrow or rhythm.
- Must hold: the `q`/`page` URL contract and `searchProductsParamsSchema`; the pager's
  landmark `aria-label` summary (`:174`), `aria-current="page"` (`:246`) and per-link
  `aria-label`s (`:247,255,281,288`); `force-dynamic` (`:24`).

**H5. Cart** — `cart/page.tsx` (Server, `force-dynamic`), `cart-items.tsx` (Client).

- Ships: the tinted-circle empty state (`:51-66`), a reconciliation `role="status"` banner
  (`:70-89`), a `lg:grid-cols-[1fr_20rem] lg:items-start` grid with a `lg:sticky lg:top-6`
  summary (`:68,116`), per-row thumbnails (`cart-items.tsx:65-77`), the quantity stepper
  (`:101-130`) and per-row pending/error states (`:56-59,93-97`).
- Gap to v2: the summary is a plain `Card` with no V8 chip; the header is flat; the row list
  is a bordered `divide-y` block with no panel idiom.
- Must hold: `CartItems({ items: CartItem[] })` and the `updateQtyAction` /
  `removeFromCartAction` calls (`cart-items.tsx:19,38,46`); the "Checkout" CTA
  (`cart/page.tsx:149`), a `Button render={<Link/>}` that Base UI exposes as
  `role="button"` with an `href`; the `aria-label`s "Decrease quantity", "Increase
  quantity" and `Remove ${title}`; `force-dynamic` (`:28`).

**H6. Checkout shell** — `checkout/page.tsx` (Server, `force-dynamic`),
`checkout-form.tsx` (Client), `checkout-appearance.ts` (**read-only, never edited**).

- Ships: the same empty state and a `lg:grid-cols-[1fr_20rem]` grid (`:80`), a two-step
  Details → Payment indicator (`checkout-form.tsx:422+`), three `SectionPanel`s
  (`:195,223,254`), a phase-2 read-back `<dl>` (`:178-197`) and the `matchMedia`
  dark-scheme subscription (`:112-124`) feeding `buildCheckoutAppearance` (`:130-133`).
- Gap to v2: the panels are right, but the page frame is baseline (flat header, `py-10`, no
  stage) and the summary rail has no V8 chip.
- Must hold: `startCheckoutAction`'s input/output contract and the two-phase `started`
  machine; the `<Elements>` mount (`:199-213`); **every** field label — "Email", "Full
  name", "Address", "City", "State", "ZIP code" — plus "Continue to payment" and `/^Pay/`;
  `checkout-appearance.ts` untouched; `force-dynamic` (`:28`).

**H7. Order confirmation** — `checkout/success/page.tsx` (Server, `force-dynamic`),
`checkout-complete.tsx` (Client, side-effect only).

- Ships: a four-way verified view (`:70-80`), a tinted status circle plus heading and
  message (`:88-104,130-145`), two `SectionPanel`s (`:153,188`) in a `max-w-lg` column
  (`:130`).
- Gap to v2: the hero is centered and small-scale; the heading is `text-3xl`, not the V1
  ladder.
- Must hold: the exact "Payment received" heading string (`:79`); the four-way logic and its
  `getCheckoutResult` verification; `CheckoutComplete`'s single cart-clear side effect;
  `force-dynamic` (`:27`).

**H8. Account cluster** — `account/page.tsx`, `account/orders/page.tsx`,
`account/orders/[id]/page.tsx` (all Server, `force-dynamic`), `account/section-panel.tsx`.

- Ships: an identity header, two panels and a quiet secondary CTA
  (`account/page.tsx:32-101`); a tinted-header orders table with `tabular-nums` and the
  tinted-circle empty state; a `Breadcrumb` plus a panelized order detail
  (`[id]/page.tsx:97-…,169,229`).
- Gap to v2: `text-2xl` headers, `max-w-2xl`/`max-w-3xl` columns on a flat rhythm, no
  eyebrow or stage.
- Must hold: the `getShopperSession()` gates and their `?redirect=` targets
  (`account/page.tsx:26-27`, `orders/page.tsx:45-46`, `[id]/page.tsx:51-60`); the tenant +
  `userId` scoped reads; `notFound()` non-streamed (`[id]/page.tsx:65-70` — **no
  `loading.tsx` under this segment**); `force-dynamic` on all three.

**H9. Auth and landing (already v2) — a consistency check, not a redo.** Once the
vocabulary is frozen the only plausible touches are: adopting V11 `px-4 md:px-6` on the auth
wrapper if the storefront standardizes on it (`sign-in/page.tsx:61` already uses `px-4` on
mobile, so it is compliant), and refreshing the landing's `STATUS` chip (`page.tsx:33`,
currently "Milestone 7 · Storefront v2 up next") plus the `MILESTONES` ladder (`:53-61`) at
the M7 handoff. Both are one-line copy edits. Expect **no** structural change; if the canvas
introduces a genuinely new idiom (a sticky header, say), re-check both surfaces then.

## Preserved E2E selectors — the exact strings M7 must not break

The suite is five specs against a production build (`pnpm build && pnpm start`),
`workers: 1`, chromium at 1280×720 (`playwright.config.ts:20-64`), plus one Vitest DOM
test. Restyling classes and wrapper elements is safe; changing **text, label associations,
ARIA roles, or the number of matching elements** is not.

**`e2e/checkout.spec.ts`** (PDP → cart → checkout → confirmation)

- `:76` `getByRole("button", { name: "Add to cart" })` — `purchase-panel.tsx:134`. **Must
  stay unique**: a second a11y-visible "Add to cart" (a mobile buy bar rendered at desktop
  width, say) is a strict-mode violation.
- `:78` `getByText("Added to cart")` — `purchase-panel.tsx:142`.
- `:84` `getByRole("button", { name: "Checkout" })` — `cart/page.tsx:149`, the
  `Button render={<Link/>}` pattern that renders `<a role="button">`.
- `:97-102` `getByLabel("Email")`, plus `"Full name"`, `"Address"`, `"City"`, `"State"` and
  `"ZIP code"` — all with `exact: true`.
- `:104` `getByRole("button", { name: "Continue to payment" })`; `:111,133`
  `getByRole("button", { name: /^Pay/ })`.
- `:112-114` `frameLocator('iframe[src*="elements-inner-accessory-target"]')` — Stripe's own
  markup, not ours, but the surrounding `<Elements>` mount must stay intact.
- `:139` `getByRole("heading", { name: "Payment received" })` — `success/page.tsx:79`.

**`e2e/product-images.spec.ts`** (the gallery's own spec — read it before rebuilding)

- `:68` `getByRole("heading", { name: "Enamel Mug" })` — the PDP `h1`.
- `:70` `expect(getByRole("img", { name: "Enamel Mug" })).toHaveCount(0)` **before** upload:
  the image-less PDP must render **no** `<img>` carrying the product's accessible name. The
  placeholder branch is `aria-hidden` (`product-image.tsx:39-43`,
  `products/[slug]/page.tsx:90-99`).
- `:104` `getByRole("img", { name: "Product image 1" })` — the **admin** manager's alt text.
- `:114-115` on `/products`: `getByRole("link", { name: "Enamel Mug" })` scoping
  `getByRole("img", { name: "Enamel Mug" })` — the card's link-wraps-image structure
  (`product-card.tsx:40-52`).
- `:122-124` `expect(getByRole("img", { name: "Enamel Mug" })).toBeVisible()` **after**
  upload, with `src` matching `/uploads/`. **The hard constraint:** with exactly one image
  the PDP must expose **exactly one** a11y-visible `<img>` named after the product. Gallery
  B's single-image state already says "no rail, no arrows" (`canvas.json:185`), so this
  holds — but a viewer that pre-mounts slides, a duplicated `<img>` for a zoom layer, or a
  decorative background copy would trip strict mode. Any extra copy must be `aria-hidden` or
  carry a different accessible name.
- `:79-81` admin sign-in through the shared form: `getByLabel("Email")`,
  `getByLabel("Password")`, `getByRole("button", { name: "Sign in" })`.
- `:86-88` `getByRole("row").filter(…).getByRole("link", { name: "Edit" })`; `:93`
  `getByText("No images yet. Add one to show it on the storefront.")` — admin surface, out
  of M7 scope, but don't disturb it.

**`e2e/onboarding.spec.ts`** — `:73-76` `getByLabel("Name")`, `"Email"`, `"Password"` plus
`getByRole("button", { name: "Create account" })` (the **shared** `SignUpForm`); `:81`
`getByRole("heading", { name: "Create your store" })`; `:85-87` `getByLabel("Store name")`,
`"Subdomain"` and `"Create store"`; `:94-96` the "Dashboard" heading,
`getByText("An overview of <name>.")` and "Sign out".

**`e2e/admin-auth.spec.ts`** — `:24` `getByRole("heading", { name: "Sign in" })` (the
**platform** `(auth)/sign-in` heading, not the storefront's "Welcome back"); `:35-37,68-70`
`getByLabel("Email")`, `"Password"` and "Sign in"; `:44,47,77` "Sign out"; `:78`
"Dashboard".

**`e2e/landing.spec.ts`** — `:29-32` `getByRole("heading", { level: 1, name:
"Multi-tenant commerce platform" })`; `:38-42` "Create your store" **`toHaveCount(2)`** →
`href="/new"`; `:43-47` "Shop the store" **`toHaveCount(2)`** → `href="/products"`; `:48-51`
"Admin" → `/admin`; `:52-54` "Health check" → `/api/health`; `:57`
`getByText("Phase 0")` count 0. **The two count assertions pin the number of CTAs** — adding
or removing a copy of either button breaks the spec.

**`src/app/(storefront)/account/account-menu.test.tsx`** (Vitest DOM) — `:118-119,126-127`
the name / email / "Your account" fallbacks; `:132`
`getByRole("link", { name: /my orders/i })` → `/account/orders`; `:143` a node carrying
`TENANT_THEME_PORTAL_ATTR`; `:151,174` `getByRole("button", { name: /sign out/i })`.

**Cross-surface reminder.** `SignInForm`, `SignUpForm` and `PasswordInput`
(`src/components/auth/*`) are shared by the storefront **and** the platform `(auth)` pages;
their labels and button text are pinned by three specs at once. And the M6-09 lesson:
`getByLabel("Password")` is a **substring** match, which is exactly why the visibility
toggle is named "Show"/"Hide". Any new accessible name M7 introduces — "Previous image",
"Next image", "Zoom in", "Open fullscreen viewer" — must not substring-collide with an
existing queried name.

## Risks & unknowns

**Risk #1 — breaking the E2E suite's selectors.** As enumerated above. Mitigation: each
issue repeats its screen's exact strings, and the PDP, cart and checkout issues run the full
`pnpm build && pnpm test:e2e` (all five specs), never a storefront-looking subset.

**Risk #1a — strict-mode duplicates from the new gallery (new).** `getByRole("img", { name
})` and `getByRole("button", { name: "Add to cart" })` must each resolve to exactly one
a11y-visible node on the PDP. Two concrete traps: a viewer that keeps slides mounted, and
the mobile sticky buy bar. For the bar, `md:hidden`/`lg:hidden` is `display:none` at 1280px
and therefore genuinely invisible to role queries — **but a `translate-y-full` /
`opacity-0` "hidden" bar is still in the a11y tree and will break the spec.** Hide it with
`display:none`, or give its CTA a distinct accessible name.

**Risk #2 — client contracts.** `PurchasePanel`, `CartItems` and `CheckoutForm` keep their
props and Server Action call shapes (M6 proved this discipline PR by PR). The **one**
sanctioned extension this milestone is `addToCartAction(variantId, qty)` — already in the
signature and the schema, so no server change. Two client shapes may legitimately grow and
both must be named in `GOAL.md` → Exceptions: `GalleryImage` gaining `width`/`height` for
the viewer, and any other display-only field. **No repository or service query may widen.**

**Risk #3 — Payment Element theming (silent).** `checkout-appearance.ts` reads computed CSS
custom properties off `[data-tenant-theme]` and converts OKLCH → sRGB, because the Stripe
iframe cannot read page CSS. It degrades silently — a regression fails no test, the widget
just reverts to Stripe's default preset. The failure modes are restructuring the theme
wrapper or dropping the `--input`/`--radius` tokens it reads. Mitigation: the checkout PR is
manually clicked through the payment step in **light and dark**, and
`checkout-appearance.ts` is only ever read from.

**Risk #4 — portal escape for the viewer.** Any body-portaled overlay leaves
`[data-tenant-theme]` and falls back to the platform accent (`src/lib/theme.ts:35-51`).
`DropdownMenu` and `Dialog` do **not** self-stamp; `select.tsx:93` and `mobile-nav.tsx:81`
stamp by hand. For the viewer, either set `portal.root` to the storefront wrapper or stamp
`TENANT_THEME_PORTAL_ATTR` on `portal.container` (§D).

**Risk #5 — `force-dynamic` on new files.** Any new page-level segment must re-declare it or
the DB-less CI build fails at prerender. Sub-components inside an existing page inherit the
page's mode and need nothing.

**Risk #6 — a third-party stylesheet versus Tailwind v4's cascade layers (new).** Tailwind
puts utilities in `@layer utilities`; the lightbox's `styles.css` is **unlayered**, so its
`.yarl__*` rules **beat** any Tailwind utility on the same element. Consequence: theme the
viewer with its `--yarl__*` custom properties and its `styles` slot props, **not** with
Tailwind classes. Import the stylesheet from exactly one module (the gallery), since Next's
CSS order follows import order (`01-app/01-getting-started/11-css.md:400-451`); a second
import site makes the order non-deterministic. Also confirm the production build really
emits the chunk when the viewer is `next/dynamic`-loaded — verify on `pnpm start`, not
`pnpm dev`.

**Risk #7 — LCP regression from a bigger cover (new).** The cover grows from a
`md:grid-cols-2` square to a 4:5 tile in a 7fr/5fr split, so the LCP image gets larger. Keep
exactly one `preload` (`product-gallery.tsx:37`), update `sizes` to match the new column
(today `"(min-width: 768px) 45vw, 100vw"`), and never `preload` the rail or the viewer's
slides.

**Risk #8 — sticky bars, scroll lock and iOS (new).** `env(safe-area-inset-bottom)` is 0
without `viewport-fit=cover` (§E), so use `max(1rem, env(...))`. A modal viewer locks page
scroll (Base UI `modal: true`; the lightbox's own NoScroll module), which combined with a
`position: fixed` bottom bar can leave the bar floating over the scrim — hide the bar while
the viewer is open. Slideshow autoplay must respect `prefers-reduced-motion` (DESIGN.md:15):
gate it on `matchMedia("(prefers-reduced-motion: reduce)")`, the pattern
`checkout-form.tsx:118-124` already uses for the color scheme.

**Risk #9 — chrome churn invalidating the PDP canvas (new).** The frozen canvas was drawn
**inside the shipped chrome** (`canvas.json:169` — "Matches the shipped storefront … h-8
chrome controls … max-w-6xl container"). If M7 later makes the header sticky or translucent,
or changes container padding (V11), the PDP's sticky `top-*` offsets and the canvas's frames
go stale. Hence the sequencing recommendation below.

**Risk #10 — honest content (new).** DESIGN.md:58 rejects "fake data that looks fake". The
canvas's reviews, ratings, delivery estimate and Color axis are fabricated preview content
and `canvas.json:169` says so explicitly. Shipping any of them as decoration would be the
single most damaging thing this milestone could do to a portfolio project. Every (b) item
gets explicit sign-off in `GOAL.md`, or it is cut.

**Risk #11 — adding a dependency at all.** `package.json` and `pnpm-lock.yaml` had **zero
diff** across the whole of M6 (`handoff.md:141-143`). Adding a lightbox breaks that streak
and needs a decision-log entry in `docs/ARCHITECTURE.md` §9 carrying the reasoning from §D.
The user gates it; if refused, the Base UI `Dialog` fallback is the plan.

**Open questions for `/milestone-start`:**

1. **Ship the viewer dependency, or the Base UI `Dialog` fallback?** (Risk #11.)
2. **Do the accordions ship?** If yes, add the base-nova `accordion` primitive and write
   honest store-level copy for Materials / Size & fit / Shipping (§C).
3. **Does the chrome change at all?** If the header becomes sticky, that decision must land
   _before_ the PDP (Risk #9).
4. **Does `viewportFit: "cover"` land in the root layout,** or does the mobile bar use the
   `max(1rem, env(...))` no-op fallback? (Recommend the latter for a UI-only pass.)
5. **4:5 cover: crop or letterbox** the square seed photos? (§C.)

## Recommended approach

**Sequence — one design-language step, then the PDP, then outward.** `GOAL.md` proposes PDP
first, and that is right _provided the chrome question is settled first_: every screen
renders inside the chrome, and the frozen canvas was drawn inside **today's** chrome. So a
short **design-language + chrome decision** step must precede the PDP. It is cheap either
way — it confirms "chrome unchanged" (the frozen canvas stays valid and the PDP starts
immediately) or it changes the chrome once, up front, before eleven screens are built
against the old one. That reasoning is what `GOAL.md`'s committed order encodes:

> M7-01 (design language + chrome decision) → M7-02 chrome **only if it changes** → M7-03
> PDP gallery + viewer → M7-04 PDP page layout → M7-05 listing → M7-06 search → M7-07 cart
> → M7-08 `SectionPanel` prep → M7-09 checkout → M7-10 confirmation → M7-11 account →
> M7-12 auth + landing pass.

Per-issue notes this brief adds to that plan:

- **M7-01** should freeze §A's V1–V14 verbatim as the canvas's reference list, and must
  answer five things: sticky header or not (Risk #9), V11 padding, V12 rhythm, the
  elevation policy (V9), and the card aspect (V10 — the canvas already answers it: cards
  stay **square**, only the PDP cover is 4:5).
- **M7-03** is the milestone's only genuinely new construction and the only PR that can add
  a dependency. Consider landing the on-page gallery and the viewer as two commits inside
  it (or two PRs if review gets heavy): the gallery alone is provable against
  `product-images.spec.ts`, and isolating the viewer keeps the dependency decision
  reviewable on its own. Whatever ships, re-read §"Preserved E2E selectors" first — the
  single-image PDP must still expose exactly one a11y-visible `<img>` named after the
  product (Risk #1a).
- **M7-04** gets the quantity stepper for free from `addToCartAction`'s existing optional
  `qty` (§C) — reuse the cart's stepper markup (`cart-items.tsx:101-130`) rather than adding
  a `number-field` primitive that base-nova does not ship (§F).
- **M7-08** (`SectionPanel`) lands after cart in the committed order, i.e. immediately
  before the three screens that consume it (checkout, confirmation, account) — which is what
  matters. **One caveat:** if M7-01's canvas changes the panel shell itself (V3/V9), do the
  extraction _first_ and restyle once, or checkout/confirmation/account each get the same
  edit three times.
- **M7-12** is expected to be a copy refresh only (the landing's `STATUS` chip,
  `page.tsx:33`, and the `MILESTONES` ladder, `:53-61`) — see §H9.

**Where the seams are.** The gallery is the only new construction; everything else is
re-composition of idioms that already ship (the V8 chip, `SectionPanel`, the tinted-circle
empty state, `Breadcrumb`, `Skeleton`, `Sheet`). Every screen issue is therefore a
markup-and-class change inside files that already exist, with the frozen contracts in §H as
the checklist.

**Per-PR loop**, unchanged from M6: `/design` canvas → user approves → implement in place →
`pnpm typecheck && pnpm lint && pnpm build` → a live click-through on `pnpm start` in light
**and** dark, desktop **and** mobile (the scratchpad Playwright screenshot script is the
reliable way to get all four) → run the relevant spec, and the **full** suite for anything
touching the PDP, cart, checkout, confirmation or the shared auth forms → a small,
single-screen PR.

## References

**Repo, read this pass:** `CLAUDE.md`, `AGENTS.md`, `docs/DESIGN.md`,
`docs/ARCHITECTURE.md:186-387` (§9 decision log, including the five M6 entries at
`:361-386`), `docs/milestones/M7-storefront-v2/GOAL.md`,
`docs/milestones/M6-ui-redesign/{GOAL,research,handoff}.md`,
`docs/milestones/README.md:59-60`, `docs/milestones/_templates/research.md`.

**Storefront source:** `src/app/(storefront)/layout.tsx`, `mobile-nav.tsx`, `nav-link.tsx`,
`store-brand.tsx`, `search/search-form.tsx`, `search/page.tsx`, `products/page.tsx`,
`products/product-card.tsx`, `products/product-image.tsx`,
`products/product-grid-skeleton.tsx`,
`products/[slug]/{page,purchase-panel,product-gallery,not-found}.tsx`,
`cart/{page,cart-items,actions}.tsx`, `checkout/{page,checkout-form}.tsx`,
`checkout/success/page.tsx`, `account/{page,section-panel,auth-stage,account-menu}.tsx`,
`account/{orders/page,orders/[id]/page,sign-in/page}.tsx`, `account/account-menu.test.tsx`;
`src/app/{page,landing-stage,layout}.tsx`;
`src/lib/{cart,theme,pagination,validators/catalog}.ts`; `src/app/globals.css`;
`src/components/ui/{button,dialog,sheet,skeleton,breadcrumb,badge}.tsx`;
`src/components/auth/*`; `prisma/seed.ts:175-205`; `next.config.ts`; `components.json`;
`playwright.config.ts`; `e2e/{checkout,product-images,onboarding,admin-auth,landing}.spec.ts`.

**Frozen PDP v2 canvas** (`/design`, Fable 5.1, 2026-09-07; scratchpad `pdp-v2/`):
`canvas.json` — pages, artboards and annotations, including the brief at `:169`, the
gallery-B note at `:185` and the mobile note at `:177`; `build.mjs` — `buyColumn` at `:363`,
`stickyBar` at `:487`, `galleryMobile` at `:309`, the related-products card at `:466`;
`final.part.mjs:6-31` (gallery B) and `:44-96` (the viewer).

**Next 16.3.3 installed docs** (`node_modules/next/dist/docs/01-app/`):
`03-api-reference/04-functions/not-found.md:80-122`;
`03-api-reference/02-components/image.md:291-293,1404`;
`03-api-reference/03-file-conventions/02-route-segment-config/`;
`02-guides/lazy-loading.md:22-34,95`; `01-getting-started/11-css.md:314-348,400-451`; and
`node_modules/next/dist/lib/metadata/types/extra-types.d.ts:52` (`viewportFit`).

**Installed packages:** `@base-ui/react@1.7.0` (its `package.json` exports;
`dialog/root/DialogRoot.d.ts:26-34,81`; `unstable-use-media-query/index.d.ts`);
`tailwindcss@4.3.3` (`index.css:1`, the cascade-layer declaration);
`@playwright/test@1.62.1` with `playwright-core@1.62.1` (`lib/coreBundle.js` — the
strict-mode message, `isElementHiddenForAria`, the `Desktop Chrome` descriptor);
`react@19.2.8`; `next@16.3.3`.

**External, fetched 2026-09-08:**

- `https://registry.npmjs.org/yet-another-react-lightbox` — v3.32.2, MIT, no runtime
  dependencies, React 19 peer range, 241 KB unpacked across 33 files, published 2026-07-30.
- `https://data.jsdelivr.com/v1/packages/npm/yet-another-react-lightbox@3.32.2` and the
  matching `cdn.jsdelivr.net` dist files — per-file sizes; gzip measured locally (core
  16.7 KB, zoom 6.4, thumbnails 3.9, fullscreen 1.8, slideshow 1.5, counter 0.5, CSS 2.7).
- `https://yet-another-react-lightbox.com/examples/nextjs` — App Router usage: a client
  component plus `next/dynamic`, `render.slide` with `next/image`, and the Zoom-plugin
  `srcSet` caveat.
- `gh api repos/igordanchenko/yet-another-react-lightbox` — MIT, 1309 stars, 2 open issues,
  pushed 2026-09-07.
- `https://registry.npmjs.org/photoswipe/latest` (5.4.4, MIT);
  `.../react-photo-view/latest` (1.2.7, Apache-2.0); `.../lightgallery/latest` (2.9.0,
  GPLv3); `.../embla-carousel-react/latest` (8.6.0, MIT, 2 dependencies, React 19 peer).
- `https://ui.shadcn.com/r/styles/base-nova/<name>.json` for `carousel`, `accordion`,
  `tabs`, `tooltip`, `avatar`, `toggle-group`, `scroll-area`, `number-field` — availability
  probe and dependency lists.
- `gh api "repos/:owner/:repo/milestones?state=all"`, `gh issue list`, `gh pr list`,
  `gh pr view 228` — milestone, issue and PR state, and the pending dependency bump.
