# M7 — Storefront v2 (design-bar consistency pass)

> Draft stub — seeded at the M6 handoff (2026-09-08, handoff step 5). Finalize with
> `/milestone-start`, which produces `research.md`, the exit-criteria checklist, and the
> GitHub Milestone + issues, and adds the roadmap row in
> [`../README.md`](../README.md). Until then this is intent, not a committed scope.

## Goal (provisional)

Raise every storefront (user-facing) screen to the **"Fable v2" design bar** the last two
M6 screens already reached. During M6 the design bar rose: auth (#226) and the apex
landing (#230) were built from the newer Fable design canvases (split stage, hero, richer
composition), while the earlier seven surfaces — shared chrome, product listing, the PDP,
search, cart, the checkout shell, order confirmation, and the account cluster — hold the
M6 baseline. M6 made the whole storefront _consistent_; M7 makes it consistently at the
_higher_ bar. Still **UI-only**, the same "restyle presentation, never touch data"
discipline as M6. Start from the **PDP v2 canvas** already designed via `/design` (Fable
5.1) but not yet implemented — it sets the bar the rest match.

## Likely in scope (confirm at `/milestone-start`)

- Screen-by-screen v2 restyle via `/design`, ~one PR per screen, reusing the M6 design
  system (Skeleton, Breadcrumb, Sheet, the SectionPanel idiom, the tinted-circle empty
  state, `scopedThemeCss`) rather than inventing new primitives:
  - **PDP first** — implement the already-approved, frozen PDP v2 canvas (Direction A
    layout, gallery B). It anchors the v2 bar the rest are measured against.
  - Then, in turn: shared chrome, product listing, search, cart, the checkout shell,
    order confirmation, and the account cluster — each re-elevated to that bar.
  - Re-check auth and the landing for consistency — already at v2, so a check, not a redo.
- Hold `docs/DESIGN.md`; keep every existing state (loading/empty/error/disabled); keep
  the E2E selectors, the `force-dynamic` / soft-404 posture, and the client prop and
  action-call contracts byte-identical — exactly as M6 did.

## Likely out of scope (defer)

- Any data / business-logic / schema change; new storefront features.
- The **admin dashboard** redesign — that is **M8**, its own denser track.
- Re-theming the Stripe Payment Element internals / `checkout-appearance.ts` beyond
  reading from it (same Risk #3 trap as M6).
- Real logic behind the M6-09 "Coming soon" placeholders (forgot-password, social
  sign-in) — a later auth milestone, not a restyle.

## Notes

- **Depends on M6 (done):** the shared primitives and idioms are the vocabulary this pass
  reuses; see `docs/milestones/M6-ui-redesign/handoff.md` → "Inherited by next milestone".
- The **PDP v2 canvas** is already designed and frozen (via `/design`, Fable 5.1); M7
  begins by building it, then brings the other screens to match.
- The working style is the established visual-first one: `/design` canvas → implement →
  user gates each screen. UI-only, with the same E2E / soft-404 / contract guardrails M6
  proved out.
- Sequencing after M7: the **admin dashboard** redesign is planned as **M8**.
