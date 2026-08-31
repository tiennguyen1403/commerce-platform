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
