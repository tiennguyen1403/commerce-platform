# M6 — UI redesign (storefront)

> **Draft stub** — seeded at the M5 handoff (2026-09-06, handoff step 5). Finalize with
> `/milestone-start`, which produces `research.md`, the exit-criteria checklist, and the
> GitHub Milestone + issues, and adds the roadmap row in
> [`../README.md`](../README.md). Until then this is intent, not a committed scope.

## Goal (provisional)

Resume the **Claude Design UI-redesign track** — deliberately paused during M5 so products
could get real images first. Restyle the storefront screen by screen (**UI-only**:
presentation, never data or business logic), matching the approved Claude Design canvases,
now that the product card and the PDP gallery have real photography (M5) to design around.
The PDP was already redesigned ahead of the pause (PR #183); the remaining storefront
surfaces follow.

## Likely in scope (confirm at `/milestone-start`)

- Screen-by-screen storefront restyle via `/design`, UI-only, ~one PR per screen:
  product listing, search, cart, the checkout shell, the shopper account/order pages, and
  shared chrome (header/footer/nav).
- Hold the line on `docs/DESIGN.md`: a real type scale, 4px spacing grid, one OKLCH
  accent, shadcn primitives (not hand-rolled), lucide icons, accessible by default
  (labels, visible focus, AA contrast).

## Likely out of scope (defer)

- Any data / business-logic / schema change; new features.
- Re-theming the Stripe Payment Element / checkout internals beyond presentation.
- The admin dashboard redesign (its own later track).

## Notes

- **Depends on M5 (done):** real product images now fill the card + PDP gallery slots this
  redesign styles — see `docs/milestones/M5-product-images/handoff.md` → "Inherited by
  next milestone".
- The track's working style (visual-first, `/design`, UI-only, user gates each screen) is
  established from the pre-pause PDP pass.
