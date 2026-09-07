# M7 — Storefront v2 (every user screen at the Fable v2 bar)

Raise every storefront (user-facing) screen to the **"Fable v2" design bar** the last two M6
screens reached. During M6 the bar rose mid-milestone: auth (#214 → PR #226) and the apex
landing (#215 → PR #230) were built from the newer Fable design canvases — a split **stage**,
a hero, richer composition — while the earlier seven surfaces (shared chrome, product
listing, the PDP, search, cart, the checkout shell, order confirmation, the account
cluster) hold the M6 baseline. M6 made the storefront _consistent_; M7 makes it
consistently at the _higher_ bar, starting from the **PDP v2 canvas** that was designed and
frozen on 2026-09-07 but never built. Still **UI-only** — the same "restyle presentation,
never touch data" discipline as M6 — with three explicitly recorded exceptions (below).

Scope was fixed at `/milestone-start` on 2026-09-08 (this doc + [`research.md`](research.md)).
The M1–M6 rules are non-negotiable: tenant-isolated, layered (UI → service → repository →
Prisma), money in integer cents, server-only stays server-only, presentation never touches
data.

## Goal

Every screen a shopper can reach — PDP, shared chrome, product listing, search, cart,
checkout shell, order confirmation, account (home / orders / order detail) — restyled to the
v2 vocabulary below via an approved `/design` canvas, ~one PR per screen, holding
`docs/DESIGN.md` (restraint, one OKLCH accent, a real type scale, a 4px grid, shadcn/Base UI
primitives, lucide icons, accessible by default). Auth and the landing are already at v2
and get a consistency pass, not a redo. Light + dark correct; every existing state
(loading/empty/error/disabled) preserved; every data shape, Server Action, query, tenant
scope, and E2E selector untouched.

## What "v2" means (the bar, in code)

Derived by diffing the two shipped v2 surfaces (`account/auth-stage.tsx` + the auth pages,
`src/app/page.tsx` + `landing-stage.tsx`) against the M6 baseline — the code-level list is
`research.md` §A, **V1–V14** (display type ladder, `text-balance`/`text-pretty`, the
`bg-accent rounded-2xl` stage, the `accent-foreground` pairing, the `lg:` two-column stage
grid, eyebrow, status chip, the size-9 accent icon chip, `shadow-lg` + ring elevation,
square imagery, `px-4 md:px-6`, `py-12 lg:py-16` rhythm, chip list, `motion-safe`). M7-01
freezes it as a design-language canvas plus a short "Storefront idioms (v2)" addendum to
`docs/DESIGN.md`, so every later screen (and M8's admin) inherits one vocabulary instead of
re-deriving it per canvas.

- **A stage, not a title.** Each screen gets one strong composition — an accent-tinted
  editorial panel (auth), a hero (landing), a cover image + sticky buy box (PDP) — instead
  of a flat heading over content. Text on the accent tint pairs with `--accent-foreground`
  (muted grey on the tint is ~4.25:1, under AA).
- **Explicit hierarchy.** Display-size heading tiers, one primary action per screen,
  supporting facts demoted into panels; `tabular-nums` on every number.
- **Imagery first where the data has images.** PDP: a 4:5 cover, thumbnail rail,
  fullscreen viewer; cart/checkout rows keep their thumbnails. **Cards stay square** (V10 —
  the frozen PDP canvas's own related-products card is 1:1); only the PDP cover is 4:5.
- **Sticky commerce controls where the flow benefits** — the PDP buy box (desktop) and a
  compact bottom buy bar once the main CTA scrolls away (mobile); nowhere else unless a
  canvas argues for it.
- **The same foundations.** No new tokens in `globals.css`, no new radii or shadow levels
  beyond the `shadow-lg` the landing introduced, the container-width-by-density widths
  unchanged, the existing M6 idioms reused verbatim: `SectionPanel`, the tinted-circle
  empty state, `Skeleton` / `Breadcrumb` / `Sheet`, `scopedThemeCss`.
- **Honest content only.** Nothing the DB doesn't hold — see Out of scope for the PDP
  canvas's fabricated preview content (research Risk #10).

## The UI-only contract (carried from M6, plus M7 specifics)

- **Presentation only.** No change to data shapes, Server Actions, repository/service
  queries, tenant scoping, or Stripe internals. Restyle the Server Component page where
  possible; keep client-component **props + action-call contracts** byte-identical
  (`PurchasePanel`, `CartItems`, `CheckoutForm`, `AccountMenu`). A new data read is out of
  scope unless recorded under Exceptions (the M6-08 rule); **no repository or service query
  may widen** in M7.
- **Preserve E2E selectors.** Five Playwright specs + `account-menu.test.tsx` run
  accessible-name queries against markup M7 rebuilds — the exact strings are enumerated in
  `research.md` §"Preserved E2E selectors" and repeated in each issue. Playwright is
  **strict**: on a one-image PDP exactly one a11y-visible `<img>` may carry the product's
  name and exactly one "Add to cart" button may exist, so the viewer mounts only when
  opened and the mobile buy bar is hidden with `display:none` (`md:hidden`), never with
  `translate`/`opacity` (Risk #1a). New accessible names (arrows, expand, zoom, close) must
  not substring-collide with any queried name (the M6-09 `getByLabel` trap).
- **Silent traps stay guarded.** `checkout-appearance.ts` (Payment Element theming) is
  read-only and verified manually in light **and** dark; no route-level `loading.tsx` under
  `/products/[slug]` or `/account/orders/[id]` (soft-404); every tenant/DB-reading page keeps
  `export const dynamic = "force-dynamic"`; every body-portaled overlay — the viewer
  included — reaches the tenant accent (mount inside `[data-tenant-theme]` or stamp
  `TENANT_THEME_PORTAL_ATTR`).
- **Primitives on demand.** Base UI / shadcn base-nova primitives are added only when an
  approved canvas needs one (`render` prop, never `asChild`; server-safe where possible).
  Exactly one third-party runtime dependency is sanctioned (Exception 2); its stylesheet is
  imported from exactly one module and themed through its CSS custom properties, never
  Tailwind classes (Tailwind v4 layers utilities below unlayered CSS — Risk #6).
- **Container-width-by-density stays** — `max-w-6xl` (listing/PDP), `max-w-5xl`
  (cart/checkout), `max-w-3xl`/`2xl` (account), `max-w-lg` (confirmation). V11/V12 change
  padding and rhythm, not widths.
- **Performance guardrail.** Exactly one `preload`ed LCP image per page (the PDP cover, the
  first grid card); thumbnails and viewer slides lazy-load; the viewer's JS loads only on
  the PDP, via `next/dynamic` from inside the client gallery (`ssr:false` is illegal from a
  Server Component), and only when opened.

## In scope

Twelve issues, ~one PR each, via `/design` (the user gates every screen on the running app):

1. **M7-01 · Design language v2 + chrome decision** — the design-language canvas (V1–V14
   verbatim, the reused M6 idioms, chrome v2 direction), a "Storefront idioms (v2)" addendum
   to `docs/DESIGN.md`, and the recorded decision whether the shared chrome changes in M7
   (sticky header or not, V11 padding, V12 rhythm, V9 elevation). Docs-only PR.
2. **M7-02 · Shared chrome v2** — sequenced by the M7-01 decision: if the chrome changes,
   this lands **before** the PDP (the PDP canvas was drawn inside the shipped chrome, and
   every sticky offset moves together — Risk #9); if not, it becomes a late consistency
   check.
3. **M7-03 · PDP v2 — gallery B + fullscreen viewer** — 4:5 cover with prev/next, expand,
   `k / N` counter; thumbnail rail (`max(6, N)` columns, single image → no rail/arrows);
   the viewer (zoom, prev/next, slideshow, thumbnails, Esc; Exception 2); a CSS scroll-snap
   mobile carousel (no Embla). Crop vs. letterbox of square photos is decided in its
   `/design` round.
4. **M7-04 · PDP v2 — page layout** — the Direction A buy column (`7fr/5fr`, sticky on
   desktop via the cart's recipe), the V1 ladder, honest info rows, Details = the real
   description, the mobile sticky bottom buy bar (`IntersectionObserver` reveal, `md:hidden`,
   `max(1rem, env(safe-area-inset-bottom))` padding), and the quantity stepper
   (Exception 1).
5. **M7-05 · Product listing v2** (card stays square; skeleton mirrors the new header).
6. **M7-06 · Search results v2.**
7. **M7-07 · Cart v2.**
8. **M7-08 · Design-system prep: shared `SectionPanel`** — extract the three near-identical
   local copies (checkout, confirmation, account) into one server-safe component with an
   `idPrefix`, immediately before the three panel screens are restyled (Exception 3).
9. **M7-09 · Checkout shell v2** (Risk #3 guard).
10. **M7-10 · Order confirmation v2.**
11. **M7-11 · Account cluster v2** (home / orders / order detail).
12. **M7-12 · Auth + landing consistency pass** — audit the two already-v2 surfaces against
    the frozen vocabulary; a ≤ 2-file PR or a close-with-note.

## Out of scope (defer)

- **Any data / business-logic / schema change; new storefront features.** Concretely, the
  PDP v2 canvas's fabricated preview content is **not built** (decision 2026-09-08): star
  ratings + reviews (no `Review` model), the Color axis / swatches (variants are a flat
  `name`), the fixed XS–XXL set (render the real variants), the "Arrives …" delivery estimate
  (no lead-time data — the static "Made to order" line is the honest version), the
  Materials / Size & fit / Shipping & returns accordions and the size-guide link (no
  per-product content — they would read as fake data), and the "You may also like"
  related-products rail (a second query). Each is a candidate for a later data milestone;
  the M7-04 issue names them so the omission is deliberate, not forgotten.
- **The admin dashboard redesign — M8.**
- Re-theming the Stripe Payment Element internals / `checkout-appearance.ts` logic beyond
  reading from it.
- Real forgot-password / social sign-in logic behind the M6-09 "Coming soon" placeholders.
- Root-layout changes (e.g. `viewport.viewportFit: "cover"` — it would also touch admin and
  auth); the mobile buy bar uses the `max(1rem, env(safe-area-inset-bottom))` fallback,
  which degrades to `1rem` today.
- Sorting/filtering on the listing, a real per-tenant storefront landing page, and #229
  (the apex "Shop the store" link — a scoped logic fix, tracked separately).
- Any primitive or dependency not demanded by an approved canvas (no `embla-carousel`, no
  `number-field` — the cart's stepper markup is reused).

## Exceptions to UI-only (explicitly noted)

_Where this milestone deliberately crosses "restyle presentation, never touch data", per the
escape hatch above. Each is a decision recorded at `/milestone-start` on 2026-09-08; amend
here if building forces a change._

1. **PDP quantity stepper (M7-04).** The stepper passes its value through the **existing**
   optional second parameter of `addToCartAction(variantId, qty?)`
   (`src/app/(storefront)/cart/actions.ts`), validated server-side by `addToCartInputSchema`
   (`qty` int 1–`MAX_CART_QTY` = 99, default 1) — no Server Action, schema, or service
   change. "Add" is an increment and the service clamps to live stock, so the stepper caps
   at `min(available, 99)`. The default still adds one unit, so `checkout.spec.ts`'s "Add to
   cart" flow is byte-identical.
2. **One viewer dependency + a display-only client shape (M7-03).** The fullscreen viewer
   is `yet-another-react-lightbox` (v3.32.2 at research time; MIT; zero runtime
   dependencies; React 19 peer; ~31 KB gzipped for core + Zoom / Thumbnails / Slideshow /
   Counter, deferred with `next/dynamic`). Why a dependency at all: the frozen canvas
   specifies pinch/scroll/double-click zoom, drag-to-pan, swipe, slideshow and thumbnails —
   several hundred lines of the least testable code in the repo to hand-roll — and it is
   token-friendly (`--yarl__*` custom properties take our native `oklch()` values; it is not
   an iframe, unlike Stripe). It is the **only** `package.json` change of the milestone and
   gets a `docs/ARCHITECTURE.md` §9 decision-log entry. Alongside it, the gallery's own
   client image shape (`GalleryImage`, `product-gallery.tsx`) gains display-only `width` /
   `height` (already stored on `ProductImage`) for the viewer's slides — a client prop-shape
   growth, not a query change.
3. **Shared `SectionPanel` (M7-08).** A pure refactor of three near-identical local copies
   (they differ only in the heading-id prefix and an optional description) into
   `src/components/ui/section-panel.tsx`, server-safe, with an `idPrefix`; no visual or data
   change on its own — unless M7-01 changed the panel shell, in which case the new shell is
   applied there once and said so in the PR.

## Exit criteria

_Finalized at `/milestone-start`. Adjust only with a note here if building forces a change._

- [ ] **PDP v2 built to the frozen canvas** ("Final · A layout + B gallery" page), minus the
      out-of-scope preview content: cover + arrows + expand + counter; the rail rule
      (`max(6, N)` columns; 1 image → no rail/arrows; 8 = one row) verified live with 1 / 2 /
      6 / 8 images; the viewer with zoom, prev/next, slideshow, thumbnails, Esc, focus
      trap/return and an announced counter; the mobile carousel + sticky buy bar;
      image-less products keep the placeholder; every purchase state (sold out / low
      stock / added / error) intact.
- [ ] **Every other in-scope screen** re-elevated to the M7-01 vocabulary via an approved
      canvas; light + dark correct; AA contrast (accent tint pairs with
      `--accent-foreground`); all states (loading/empty/error/disabled) intact; keyboard +
      focus-visible; `prefers-reduced-motion` respected (slideshow autoplay, the sticky-bar
      reveal, hover lifts); responsive, no horizontal body scroll.
- [ ] **UI-only held** — no change to data shapes, Server Actions, repository/service
      queries, tenant scoping, or `checkout-appearance.ts` / Payment Element internals;
      `PurchasePanel` / `CartItems` / `CheckoutForm` / `AccountMenu` keep props + action
      calls; the only crossings are the three Exceptions above.
- [ ] **`pnpm build && pnpm test:e2e` green (all five specs)** + `pnpm test`; the preserved
      selectors (research §"Preserved E2E selectors") intact — including exactly one
      a11y-visible product-named `<img>` on a one-image PDP, zero on an image-less one, a
      unique "Add to cart", and the shared auth-form labels/buttons.
- [ ] **Checkout + confirmation manually verified** in both light and dark OS scheme
      (Payment Element theming, Risk #3); the viewer verified on a themed (non-162-hue)
      tenant so the accent reaches the portal.
- [ ] **Dependencies:** only the viewer library (Exception 2), with its decision-log entry;
      no other `package.json` / `pnpm-lock.yaml` diff; primitives added only on demand;
      every new body-portal overlay reaches the tenant accent.
- [ ] **Posture unchanged:** `force-dynamic` on every tenant/DB-reading page; no route-level
      `loading.tsx` under `/products/[slug]` or `/account/orders/[id]`; exactly one
      `preload`ed LCP image per page; the viewer chunk loads only on open (verified on
      `pnpm start`).
- [ ] **`pnpm typecheck && pnpm lint` clean throughout; each PR small and single-screen**
      (the PDP is the sanctioned two-PR screen).
- [ ] **Docs:** `research.md` (done), this `GOAL.md`, the `docs/DESIGN.md` "Storefront
      idioms (v2)" addendum (M7-01), `handoff.md` at close; the roadmap row in
      [`../README.md`](../README.md) updated.

## Dependencies / sequencing

- **Depends on M6 (done):** the shared primitives and idioms are the vocabulary this pass
  reuses — `docs/milestones/M6-ui-redesign/handoff.md` → "Inherited by next milestone".
- **Order (decision 2026-09-08):** M7-01 (design language + chrome decision) → M7-02 chrome
  **only if it changes** → M7-03 → M7-04 (the PDP, the anchor every other screen is measured
  against) → M7-05 listing → M7-06 search → M7-07 cart → M7-08 `SectionPanel` prep → M7-09
  checkout → M7-10 confirmation → M7-11 account → M7-12 auth + landing pass (and the M7-02
  check if the chrome did not change). Rationale: chrome first _if_ it moves (everything
  renders inside it, and the frozen canvas assumes today's chrome); the PDP first among
  screens (it sets the bar); the three panel screens last, after their shared shell is
  extracted; auth last as in M6 (shared-form blast radius).
- **Versions:** the brief was verified against the installed tree (Next 16.3.3, React
  19.2.8, Base UI 1.7.0, Tailwind 4.3.3, Playwright 1.62.1). Dependabot PR #228 (Next
  16.3.4, lucide 1.40, …) is open; if it merges first, re-check the version-bound claims in
  `research.md` §B/§D before M7-03.
- No dependency on M4/M5 logic beyond the shared product/image/tenant reads; **M8 (admin
  redesign)** follows M7.

## GitHub

- Milestone: **M7 — storefront-v2** (#7).
- Issues **#234–#245** (build order), labelled `phase:M7`, `type:feat` / `type:chore` /
  `type:docs`, `area:ui` (+ `area:media` on the gallery, `area:payments` on checkout /
  confirmation, `area:auth` on the auth pass); each ≈ one PR:
  - #234 M7-01 design language v2 canvas + chrome decision
  - #235 M7-02 shared chrome v2 (sequenced by the M7-01 decision)
  - #236 M7-03 PDP v2 — gallery B + fullscreen viewer
  - #237 M7-04 PDP v2 — page layout, sticky buy box, mobile buy bar, quantity
  - #238 M7-05 product listing v2
  - #239 M7-06 search results v2
  - #240 M7-07 cart v2
  - #241 M7-08 design-system prep: shared `SectionPanel`
  - #242 M7-09 checkout shell v2
  - #243 M7-10 order confirmation v2
  - #244 M7-11 account cluster v2
  - #245 M7-12 auth + landing consistency pass
