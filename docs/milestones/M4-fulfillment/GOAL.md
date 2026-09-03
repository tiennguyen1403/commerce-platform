# M4 — Fulfillment

> **Stub — scope not yet finalized.** Seeded at the M3 handoff. Run `/milestone-start`
> to research and lock the scope, exit criteria, and the GitHub Milestone + issues before
> building. The bullets below are the intended direction, not a commitment.

Turn the platform's **manual** fulfillment attestation into **real** fulfillment: a shopper
provides a shipping address at checkout, a paid order is submitted to a fulfillment provider
(print-on-demand first), and its shipment/tracking flows back to the shopper's order history
and the admin. This is the milestone that makes an order actually ship.

Inherited from M3 (see [`../M3-platform/handoff.md`](../M3-platform/handoff.md)): "Mark
fulfilled" is a manual status attestation only — there is **no shipping address** anywhere in
the schema or checkout, and `src/server/fulfillment/printful.ts` still throws "not
implemented". The `FulfillmentProvider` interface (`src/server/fulfillment/provider.ts`,
`docs/ARCHITECTURE.md` §6) is the seam M4 fills.

## In scope (tentative)

- **Shipping address collection** — capture + validate a shipping address at checkout; new
  schema (an `Address` / order shipping fields), tenant-scoped, money still integer cents.
- **Real fulfillment provider** — implement `FulfillmentProvider` against a POD API
  (Printful/Printify preferred over AliExpress — real API, faster shipping, less
  payment-processor risk); provider config is per-platform for now (not per-store — that
  needs Stripe Connect, deferred).
- **Order → fulfillment lifecycle** — submit a PAID order to the provider, persist the
  provider's fulfillment/shipment IDs and status, and reconcile status transitions
  (idempotent, webhook- or poll-driven, in the same layered/atomic style as the Stripe
  refund webhook).
- **Tracking surfaced** — shipment/tracking on the shopper's `/account/orders` detail and
  in the admin order detail; the confirmation/shipping emails via the existing outbox.

## Out of scope (candidate deferrals)

- **Per-store payouts / Stripe Connect** — still deferred (reshapes payments).
- **Multi-warehouse, partial shipments, returns/RMA, real-time carrier rate shopping,
  customs/duties** — later.
- **Address book / saved addresses** for repeat shoppers — optional fast-follow.

## Exit criteria

_To be finalized at `/milestone-start`._

- [ ] TBD — a paid order with a shipping address is submitted to a real (sandbox) POD
      provider and reaches a shipped/tracking state, surfaced to shopper + admin,
      tenant-isolated and layered, with tests in CI.
