# Changelog

Notable changes to this project, in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
style. Versions tag milestone releases (`vM<n>`), not semver — see
[`docs/milestones/README.md`](docs/milestones/README.md) for the process,
[`docs/milestones/M1-commerce-slice/handoff.md`](docs/milestones/M1-commerce-slice/handoff.md)
for the full M1 writeup,
[`docs/milestones/M2-production-grade/handoff.md`](docs/milestones/M2-production-grade/handoff.md)
for the full M2 writeup,
[`docs/milestones/M3-platform/handoff.md`](docs/milestones/M3-platform/handoff.md)
for the full M3 writeup,
[`docs/milestones/M4-fulfillment/handoff.md`](docs/milestones/M4-fulfillment/handoff.md)
for the full M4 writeup, and
[`docs/milestones/M5-product-images/handoff.md`](docs/milestones/M5-product-images/handoff.md)
for the full M5 writeup.

## [Unreleased]

## [vM5] — product-images — 2026-09-06

Products can now have real photos — admins add, reorder, caption, and remove them right
in the product form; the storefront shows them on product cards and a new image gallery
on the product page, with a clean placeholder for products that have none.

### Added

- The admin product form now has an image manager: upload photos, move them up or down
  to reorder the gallery, give one a caption, or remove it — changes save immediately.
- The storefront product card, listing, and search results now show a product's first
  photo instead of a placeholder icon.
- The product page now has a real photo gallery: a large main image with a row of
  thumbnails underneath when there's more than one photo.
- Products with no photos yet still show a clean placeholder — nothing breaks for
  existing products.

## [vM4] — fulfillment — 2026-09-05

Turns the admin's manual "mark as fulfilled" button into real fulfillment: a shopper now
enters a shipping address at checkout, a paid order is automatically submitted to a
print-on-demand supplier, its shipment and tracking flow back on their own, and the
shopper gets a shipping-confirmation email once it's on its way.

### Added

- Checkout now collects a shipping address (US only, for now), saved on the order
  alongside the rest of its details.
- Every product variant can be mapped to the fulfillment supplier's own catalog item,
  right from the same admin form used to manage its stock and price.
- A paid order with a shipping address is now submitted automatically to the fulfillment
  supplier (Printful) — no manual step required, and it can't accidentally be submitted
  twice.
- A background job checks in on every submitted order's shipment status. Once the
  supplier reports it shipped, the order is marked fulfilled automatically, with its
  carrier and tracking number attached.
- A shipping-confirmation email, with a tracking link, now goes out automatically once an
  order ships.
- The admin order page and the shopper's own order history both now show the shipping
  address, fulfillment status, and tracking link.
- If a submitted order gets stuck with the supplier, or its shipment status can't be read
  for too long, it's now automatically flagged on the admin order page for an operator to
  look into.

### Changed

- "Mark fulfilled" in the admin is now a manual override rather than the usual way an
  order becomes fulfilled — most orders now fulfil themselves once the supplier ships
  them.

## [vM3] — platform — 2026-09-03

Turns the single-store app into a real multi-tenant platform: every store gets its own
subdomain and can be created self-serve, shoppers can create accounts and see their
order history, the catalog is searchable, and the admin dashboard shows revenue and
orders over time.

### Added

- Self-serve store creation: sign up and launch your own store on its own subdomain in
  a few clicks, becoming its owner immediately. A person can own and run more than one
  store, switching between them from a store picker in the admin.
- Each store can pick its own accent color for its storefront, and owners can rename
  their store, from a new branding page in store settings.
- Shoppers can create an account and sign in on the storefront — kept completely
  separate from the admin's sign-in — and see a history of their past orders at that
  store.
- A search box on the storefront finds products by name or description.
- The admin now shows revenue and order-volume trend charts for the last 30 days,
  alongside the existing dashboard figures.

### Changed

- The admin now lives at a per-store address (e.g. `/admin/your-store`) instead of one
  shared admin — useful once a person runs more than one store.
- Dashboard revenue is now broken out as gross, refunds, and net, so a refunded order
  is netted out of the total instead of disappearing from it entirely.
- Checking out while signed in now links the order to the shopper's account, so it
  appears in their order history; checking out as a guest still works exactly as
  before.
- Resubmitting the same cart while signed in now only ever reuses that same shopper's
  own in-flight payment, never one matched by a typed-in email alone.

### Fixed

- The link that returns a shopper to where they were right after signing in could be
  crafted to send them to an external site instead; it's now validated more strictly
  so it can never leave the site.

## [vM2] — production-grade — 2026-09-02

Hardens the store for real operation: automated tests running in CI on every change,
real observability, reliable order-confirmation email, inventory held at checkout, and
a complete order lifecycle — an admin can now fulfil, cancel, and refund an order, not
just watch it become paid.

### Added

- Admin order management: view all orders (filterable by status), mark an order
  fulfilled, cancel a pending order, and issue a refund.
- Store members page (owner-only): add an existing user to help run the store, change
  their role, or remove them — the store's last owner can't be demoted or removed.
- Store settings page (owner-only): change the store's currency.
- A lean overview on the admin home page: revenue, order counts by status, low-stock
  items, and recent orders.
- A background job (via GitHub Actions and Vercel Cron) that automatically retries a
  failed order-confirmation email and cleans up checkouts a shopper abandoned partway
  through.
- Structured application logging, an error-alerting hook, and a real health-check
  endpoint suitable for uptime monitoring.
- An automated test suite (unit, service, database, and full end-to-end browser tests)
  that runs in CI on every change.
- The Stripe payment form now follows the site's light/dark theme instead of Stripe's
  default styling.

### Changed

- Inventory is now reserved the moment a shopper starts checkout, not just decremented
  after payment — two shoppers can no longer both "buy" the last unit of something.
- A shopper who resubmits the same cart (after an error, or navigating back) reuses
  their in-flight payment instead of starting a duplicate one; checkouts abandoned for
  more than 30 minutes are automatically released.
- Order-confirmation email now retries automatically instead of being sent once and
  forgotten; leaving the email service unconfigured no longer prevents the app from
  starting — checkout still works, only the email is skipped.
- Every privileged admin action is now checked against the signed-in user's role on
  the server, not just hidden from the menu.

### Fixed

- Cancelling a pending order now also cancels its payment at Stripe, so a shopper can
  no longer complete a payment against an order that was just cancelled.
- A pre-existing migration that could break deployment onto a non-empty database is
  now caught automatically, and every new migration is checked the same way going
  forward.

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

[unreleased]: https://github.com/tiennguyen1403/commerce-platform/compare/vM5...HEAD
[vm5]: https://github.com/tiennguyen1403/commerce-platform/releases/tag/vM5
[vm4]: https://github.com/tiennguyen1403/commerce-platform/releases/tag/vM4
[vm3]: https://github.com/tiennguyen1403/commerce-platform/releases/tag/vM3
[vm2]: https://github.com/tiennguyen1403/commerce-platform/releases/tag/vM2
[vm1]: https://github.com/tiennguyen1403/commerce-platform/releases/tag/vM1
