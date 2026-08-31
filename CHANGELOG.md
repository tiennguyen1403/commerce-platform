# Changelog

Notable changes to this project, in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
style. Versions tag milestone releases (`vM<n>`), not semver — see
[`docs/milestones/README.md`](docs/milestones/README.md) for the process and
[`docs/milestones/M1-commerce-slice/handoff.md`](docs/milestones/M1-commerce-slice/handoff.md)
for the full M1 writeup.

## [Unreleased]

## [vM1] — commerce-slice — 2026-09-01

Turns the scaffold into a demoable store: a shopper browses the catalog and completes a
Stripe test-mode purchase; an admin manages the catalog behind auth.

### Added

- Storefront product list + product detail pages, server-rendered with per-product SEO
  metadata; a missing or unpublished product is a real 404.
- Cookie-backed cart — add, change quantity, remove — reconciled against live price and
  stock on every view.
- Checkout: Stripe PaymentIntent + an embedded Payment Element, test-mode card payment.
- Order confirmation: an email (via Resend) sent once payment is verified, plus an
  on-site confirmation page.
- Admin dashboard: authenticated `/admin`, product + variant management (create, edit,
  archive) scoped to the store.
- Sign-in / sign-up pages and a seeded demo admin account.
- A visual pass: one accent color, automatic light/dark mode, consistent icons across
  storefront and admin.

### Changed

- A store now has a single currency; every product, cart, and order uses it — a cart can
  no longer mix currencies.
- Deleting a product variant that has already been ordered is now blocked with a clear
  error, instead of silently breaking order history.
- Paid orders decrement the purchased variants' stock. If two shoppers race for the last
  unit, the payment still succeeds and the shortfall is flagged for manual follow-up
  rather than allowed to oversell silently.

### Fixed

- The order confirmation page no longer trusts the payment reference alone to show order
  details — it verifies against the live Stripe payment first, closing an
  information-disclosure gap.

[unreleased]: https://github.com/tiennguyen1403/commerce-platform/compare/vM1...HEAD
[vm1]: https://github.com/tiennguyen1403/commerce-platform/releases/tag/vM1
