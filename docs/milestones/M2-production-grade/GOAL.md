# M2 — Production-grade

> **Stub.** Seeded at the M1 handoff. Finalize the goal, scope, and **exit criteria**
> via `/milestone-start` (research → plan → issues) before building.

Harden the M1 commerce slice into something production-grade: real access control,
operational visibility, and the reliability / quality bar a live store needs.

## In scope (draft — from the GitHub Milestone description)

- **RBAC surfacing** — enforce and expose the `OWNER > ADMIN > STAFF` roles in the admin UI.
- **Analytics dashboard** — orders / revenue / stock at a glance.
- **Inventory** — reservation / backorder handling beyond decrement-at-capture.
- **Webhook order state machine** — expand beyond `PENDING → PAID` (fulfilment, refunds).
- **Search** — catalog search for the storefront / admin.
- **Tests** — Vitest unit (services) + Playwright E2E (checkout, auth-gated admin).
- **Observability** — structured logging, error tracking, health / metrics.

## Out of scope (later milestones)

Subdomains / theming / onboarding / Stripe Connect (M3); Printful / POD fulfilment (M4).

## Exit criteria (TBD — set at `/milestone-start`)

- [ ] TODO — define measurable, checkable criteria during M2 research/planning.

## Carried-over issues (filed during M1)

- **Reliability / resilience:** #30 (email outbox + retry), #31 (bound the Resend send
  with a timeout), #39 (missing email config must not crash boot), #41 (`updateWithVariants`
  transaction timeout).
- **Payments / checkout:** #25 (dedupe PaymentIntents / sweep abandoned `PENDING`),
  #27 (Payment Element dark mode), #40 (oversell confirmation email).
- **Catalog / admin:** #35 (let an admin change the store currency).
- **Ops / migration:** #38 (`Account.issuer` NOT-NULL migration safety).

Backlog (unmilestoned, triage at `/milestone-start`): #34 (soft-flag / archive variants),
#42 (storefront caching — isolate the cart badge).

See the M1 handoff: [`../M1-commerce-slice/handoff.md`](../M1-commerce-slice/handoff.md).
