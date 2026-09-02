# M3 — Platform

Turn the single-store, production-grade app from M2 into a multi-store **platform**:
richer storefront discovery, real analytics, authenticated shoppers, and the
subdomain/billing plumbing a multi-tenant SaaS needs. Scope, issues, and exit criteria
are finalized at `/milestone-start`; see `research.md` once that produces it.

## Scope — TBD at `/milestone-start`

Candidate scope, pulled from M2's own out-of-scope list
(`docs/milestones/M2-production-grade/GOAL.md`) and the two follow-ups filed at the M2
handoff review (`docs/milestones/M2-production-grade/handoff.md`):

- **Catalog search** — deferred from M2 (`GOAL.md`'s out-of-scope list).
- **Full analytics dashboard** — time-series/sparkline charts, deferred from M2; also
  net (or clearly label) `REFUNDED` revenue instead of dropping it wholesale, per #93.
- **Subdomains / theming / onboarding** — per-tenant subdomains, storefront theming,
  and a self-serve store-creation flow.
- **Stripe Connect** — platform-side payments across multiple stores.
- **Authenticated checkout / customer accounts** — a shopper signs in and gets an
  order history, instead of only ever checking out as a guest. Closes #92
  (guest-checkout PaymentIntent reuse trusts a client-supplied email) by construction:
  once checkout is tied to a signed-in account, the reuse match binds to the account,
  not an unauthenticated email string.
- **Email invitations for non-existing users** — the M2 members page is
  add-existing-user-only (see the session-hijack finding in
  `docs/milestones/M2-production-grade/research.md`); inviting someone without an
  account yet is an optional fast-follow.
- **Partial refunds + automatic restock on refund** — M2 shipped full-refund-only with
  no automatic restock (goodwill vs. return is ambiguous); revisit both.

## Exit criteria

_TBD at `/milestone-start`._
