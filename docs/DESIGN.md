# Design system — "made, not generated"

Our in-house design guide (we chose shadcn/ui + these rules over an external design skill).
The goal: UI that looks intentionally crafted, not auto-generated. Every screen we build
should pass this bar.

## Principles

1. **Restraint over decoration.** Fewer colors, fewer borders, fewer shadows. Whitespace
   and hierarchy do the work.
2. **Hierarchy is explicit.** Size, weight, and color separate primary/secondary/tertiary.
   Don't make everything the same, and don't center everything.
3. **Consistency.** One radius scale, one shadow scale, one spacing grid, one accent.
4. **Accessible by default.** Labels on inputs, visible focus rings, AA contrast, full
   keyboard operation, respect `prefers-reduced-motion`.

## Foundations

- **Color** — Tailwind v4 + **OKLCH**. One neutral ramp + **one** accent. Define semantic
  tokens (`--background`, `--foreground`, `--muted`, `--border`, `--primary`, …) in
  `globals.css` and support light + dark. Never hardcode hex in components — use tokens /
  Tailwind classes bound to them.
- **Typography** — Geist (already wired). A real scale: `text-xs … text-5xl`, don't invent
  in-between sizes. Body ~`text-base`/`leading-7`; limit measure to ~`max-w-prose` for
  reading. Weight for emphasis, not italics-everywhere.
- **Spacing** — 4px grid (Tailwind's default scale). Consistent section rhythm; group
  related things with proximity.
- **Radius & elevation** — one radius token (shadcn `--radius`); at most 2 shadow levels.
  Prefer borders/`bg-muted` over heavy shadows.
- **Icons** — **lucide-react** only. No emoji as UI icons.
- **Motion** — subtle and purposeful (150–200ms). No gratuitous animation.

## Components

- Build from **shadcn/ui** primitives (`components/ui/`). Don't hand-roll buttons/inputs
  /dialogs. Extend via composition, keep primitives unmodified where possible.
- Every interactive component handles its **states**: default, hover, focus-visible,
  active, disabled, **loading**, **empty**, and **error**. Skeletons for loading lists.
- Forms: label + description + error text; validate with zod; disable submit while pending.

## Commerce patterns

- **Price** — always via `formatMoney(cents, currency)`; never render raw cents.
- **Product card** — image (fixed aspect ratio, `object-cover`), title (truncate),
  price, one primary action. Consistent card sizing in grids.
- **PDP** — gallery + title + price + variant selector + add-to-cart; clear stock/OOS state.
- **Cart / checkout** — line items with snapshots, editable quantity, running total,
  obvious primary CTA; show loading + error states on payment.
- **Admin tables** — dense but legible; sortable headers; empty state with a CTA;
  pagination; destructive actions confirmed.

## Anti-patterns (the "AI-slop" we reject)

- Purple/blue gradient heroes, glassmorphism everywhere, neon glows.
- Everything centered; walls of same-size text; no clear primary action.
- Emoji as icons; inconsistent radii/shadows; random accent colors per section.
- Unlabeled inputs; invisible focus states; low-contrast gray-on-gray.
- Fake data that looks fake; lorem ipsum shipped to a demo.

## Checklist before calling a screen "done"

- [ ] Clear visual hierarchy and a single primary action
- [ ] Light + dark both correct; AA contrast
- [ ] All states covered (loading/empty/error/disabled)
- [ ] Keyboard + focus-visible work; inputs labeled
- [ ] Responsive; no horizontal body scroll
- [ ] Uses tokens, shadcn primitives, `formatMoney`, lucide icons

## Storefront idioms (v2) — frozen at M7-01

Additive: every rule above holds. Frozen by M7-01 (#234, 2026-09-08) from the two shipped
v2 surfaces — the apex landing (`src/app/page.tsx`, `landing-stage.tsx`) and the shopper
auth pages (`(storefront)/account/auth-stage.tsx`) — plus the M6 idioms every screen already
reuses. The canvas is linked from `docs/milestones/M7-storefront-v2/research.md` →
References, and the numbers are the research §A ids. Class strings are quoted from the code
in prettier's order — copy them, don't re-derive them.

- **V1 · Display ladder** — display `text-4xl sm:text-5xl`; stage line `text-2xl lg:text-4xl`
  (a `<p>`, so the page `h1` stays first in DOM order); page / section title
  `text-2xl sm:text-3xl`; panel title `text-base font-semibold tracking-tight`; card-title
  `h1` `text-xl` (the auth card, one line); lede `text-lg leading-7`. Never a flat
  `text-3xl`; `tabular-nums` on every number.
- **V2 · Wrapping** — `text-balance` on every display-size `h1` and stage line;
  `text-pretty` on body copy and multi-line headlines; neither on single-line labels.
- **V3 · Stage / band** — one stage per screen (a closing band may accompany it, as on the
  landing), `bg-accent rounded-2xl` with `p-6 sm:p-8 lg:px-12 lg:py-10` (band) or
  `lg:rounded-2xl lg:p-12` (stage; a full-bleed `px-4 py-6` band below `lg`).
  `rounded-2xl` is reserved for stages and bands; cards stay `rounded-xl`.
- **V4 · AA pairing on the tint** — secondary copy on `bg-accent` is `text-accent-foreground`
  (9.6:1 in light), never `text-muted-foreground` (4.25:1, under AA). Hue-independent:
  4.20–4.25 vs 9.5–10.5 across hues 0 / 60 / 162 / 220 / 285. An inline icon inherits its
  copy's colour; the icon inside the white chip (V8) stays `text-primary`.
- **V5 · Stage grid** — `lg:grid-cols-[minmax(0,1fr)_<stage>px] lg:items-center lg:gap-16`;
  splits at `lg`, never `md` (a split at `md` would leave the stage a ~160px measure);
  stacked below (`flex-col gap-6` on auth, `grid gap-10` on the landing).
- **V6 · Eyebrow** — `text-primary text-xs font-medium tracking-wide uppercase`, one above a
  section title, never on a stage.
- **V7 · Status / meta chip** — `border-border text-muted-foreground inline-flex w-fit
items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium` with a
  `bg-primary size-1.5 rounded-full` dot. `Badge` stays for counts and stock states.
- **V8 · Accent icon chip** — `bg-accent text-primary flex size-9 shrink-0 items-center
justify-center rounded-lg` + a `size-5` icon; on the tint invert to
  `bg-card ring-foreground/10 ring-1`. One per panel header.
- **V9 · Elevation** — two levels for storefront-authored surfaces:
  `hover:shadow-sm motion-safe:hover:-translate-y-0.5` (the product-card hover lift — on
  the `Card` itself since M7-05, whose controls sit beside the link) and
  `ring-foreground/10 shadow-lg ring-1` on a free-floating surface (menus, the
  viewer chrome, a window on a stage). An edge-anchored bar (the `Sheet`, the mobile buy
  bar) carries a border on its anchored edge instead of a downward shadow — the buy bar adds
  `bg-background/95` + `backdrop-blur` while content scrolls beneath it. In-flow cards,
  panels, tables, forms and the sticky buy box stay flat rings; no `shadow-xl` / `2xl`, no
  colored glows; shadcn primitives keep their own defaults.
- **V10 · Image aspect** — cards, rail thumbs and cart / checkout thumbnails stay square; only
  the PDP cover is 4:5. Every frame **crops** (`object-cover`, centred) rather than
  letterboxing on the muted well — decided for the cover at M7-03 (#236, 2026-09-08): the
  catalog's photography is square by default (Printful mockups, the seed), a 10% side trim
  is invisible on a centred garment, and the fullscreen viewer shows every photo whole.
- **V11 · Container padding** — `px-4 md:px-6` on every page container and the footer; the
  width-by-density containers (`max-w-6xl` listing / PDP / search, `5xl` cart / checkout,
  `3xl` orders, `2xl` account home, `lg` confirmation) do not change.
- **V12 · Rhythm** — page frame `py-12 lg:py-16`; closing band `pb-16 lg:pb-20`; section
  header → content `gap-6 lg:gap-7`. Replaces the baseline frames (`py-10` on most screens,
  `py-12` account home, `py-16` confirmation) and their `gap-8`.
- **V13 · Chip list** — `bg-secondary text-secondary-foreground rounded-md px-2.5 py-1 text-sm`
  (not `bg-muted` + `text-muted-foreground`: 4.35:1, under AA).
- **V14 · Motion** — every new transform, reveal or autoplay carries `motion-safe:` (or a
  `matchMedia("(prefers-reduced-motion: reduce)")` gate in JS); color transitions need no
  guard; 150–200ms.
- **Reused as-is** — `SectionPanel` (V8 chip + `h2 text-base font-semibold tracking-tight` +
  muted description inside a `Card`, `role="group" aria-labelledby`), the tinted-circle empty
  state (`bg-muted text-muted-foreground size-14 rounded-full` + `size-7` icon, `gap-5 py-16
text-center`, a neutral circle never the accent), `Skeleton`, `Breadcrumb`, `Sheet`; every
  body-portal overlay stamps `TENANT_THEME_PORTAL_ATTR`.
- **Chrome** — the header stays static (not sticky, not translucent), so sticky offsets stay
  `top-6`; see `docs/milestones/M7-storefront-v2/GOAL.md` → Dependencies / sequencing.
