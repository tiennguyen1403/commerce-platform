import { test, expect } from "@playwright/test";

import {
  disconnectDb,
  readOrderByPaymentIntent,
  readVariantBySku,
} from "./support/db";
import { postPaymentIntentSucceeded, stripeClient } from "./support/stripe";

/**
 * The crown-jewel flow, end to end: browse → cart → checkout, pay through the REAL
 * Stripe test-mode Payment Element, then confirm the *authoritative* "paid" path.
 *
 * The browser redirect to `/checkout/success` is a UX convenience, not proof of
 * payment (see `api/webhooks/stripe/route.ts`) — so this spec doesn't stop there. It
 * hand-signs the `payment_intent.succeeded` webhook Stripe would send server-to-
 * server and asserts what actually matters, read straight from Postgres: the order
 * flips PENDING → PAID and the variant's stock is decremented.
 *
 * Real test-mode keys are unavoidable: the Payment Element talks to Stripe from the
 * browser, and both the success page and the webhook verify a genuine PaymentIntent.
 * In CI the `e2e` job supplies them; locally, export STRIPE_SECRET_KEY,
 * NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY and STRIPE_WEBHOOK_SECRET before `pnpm test:e2e`
 * (the publishable key must be set at `pnpm build`, since NEXT_PUBLIC_* is inlined
 * then — an empty one makes the Payment Element never mount).
 */

// A single-variant, well-stocked seeded product: no variant picker to drive, and
// plenty of headroom so repeated local runs stay green. Kept in lockstep with
// `prisma/seed.ts`.
const PRODUCT = { slug: "canvas-tote-bag", sku: "TOTE-OS" } as const;

// Stripe's canonical "charge succeeds immediately" test card — no 3DS step. The
// country is pinned (below) so a ZIP field always renders; postal is any 5 digits.
const TEST_CARD = {
  number: "4242 4242 4242 4242",
  expiry: "12 / 34",
  cvc: "123",
  postal: "12345",
} as const;

// Real network to Stripe (mount + confirm + redirect) plus a webhook round-trip:
// give it comfortable headroom over the 30s default so CI latency isn't a flake.
test.setTimeout(120_000);

test.afterAll(async () => {
  await disconnectDb();
});

test("checkout pays a seeded product; the webhook marks it PAID and decrements stock", async ({
  page,
  request,
}) => {
  // Fail fast with guidance if the real test-mode keys aren't wired up, rather than
  // timing out on a Payment Element that never mounted (empty publishable key). This
  // also stops a mis-provisioned CI run going green by silently skipping the flow.
  for (const name of [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
  ] as const) {
    expect(
      process.env[name],
      `${name} must be set for the checkout E2E (real Stripe test mode)`,
    ).toBeTruthy();
  }

  // Inventory baseline. A PENDING order only *reserves*; the webhook's PAID flip is
  // what decrements `stock` and releases the hold. Read it now — inside the test — so
  // a retry measures against its own starting point, not a stale absolute.
  const before = await readVariantBySku(PRODUCT.sku);
  expect(before.stock).toBeGreaterThan(0);

  // 1) Browse to the product and add one unit to the cart.
  await page.goto(`/products/${PRODUCT.slug}`);
  await page.getByRole("button", { name: "Add to cart" }).click();
  // Wait for the confirmation so the cart-cookie write has committed before we move.
  await expect(page.getByText("Added to cart")).toBeVisible();

  // 2) Cart → checkout. The "Checkout" CTA is a link styled as a button, and Base
  // UI's Button exposes it with role="button" (not "link"). A missing item would
  // render the empty-cart state with no CTA, so this also proves the add persisted.
  await page.goto("/cart");
  await page.getByRole("button", { name: "Checkout" }).click();
  await page.waitForURL(/\/checkout$/);

  // 3) Checkout phase one: email + shipping address create the PaymentIntent + a
  // PENDING order (with the address persisted server-side, #135).
  const email = `e2e-${Date.now()}@example.com`;
  const ADDRESS = {
    name: "E2E Tester",
    line1: "123 Test St",
    city: "San Francisco",
    state: "CA",
    postalCode: "94103",
  } as const;
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Full name", { exact: true }).fill(ADDRESS.name);
  await page.getByLabel("Address", { exact: true }).fill(ADDRESS.line1);
  await page.getByLabel("City", { exact: true }).fill(ADDRESS.city);
  await page.getByLabel("State", { exact: true }).fill(ADDRESS.state);
  await page.getByLabel("ZIP code", { exact: true }).fill(ADDRESS.postalCode);
  // Country defaults to the only supported country (US) — no interaction needed.
  await page.getByRole("button", { name: "Continue to payment" }).click();

  // 4) Checkout phase two — the REAL Payment Element. With several payment methods
  // enabled it renders as an accordion (Card, Bank, Cash App, …) inside a Stripe
  // iframe. Several `__privateStripeFrame`s exist and their `title`s shift over the
  // element's lifecycle, so target the one frame by its stable asset path — the
  // accordion rows and card fields both live in `elements-inner-accessory-target`.
  await page.getByRole("button", { name: /^Pay/ }).waitFor();
  const payFrame = page.frameLocator(
    'iframe[src*="elements-inner-accessory-target"]',
  );
  const cardNumber = payFrame.getByPlaceholder("1234 1234 1234 1234");
  const cardRow = payFrame.getByRole("button", { name: "Card", exact: true });
  await cardRow.waitFor();
  // The accordion starts collapsed; expand Card only if its fields aren't shown yet
  // (guards against a future default-expanded layout, where a click would collapse).
  if (!(await cardNumber.isVisible())) await cardRow.click();
  await cardNumber.waitFor();

  // Pin the billing country to US BEFORE filling, so the card form is identical
  // whatever the runner's geo: Stripe geolocates the browser, and a US-hosted CI
  // runner shows a required ZIP field that a non-US locale (e.g. a local dev box)
  // doesn't. Forcing US makes the ZIP always present and the fill deterministic.
  await payFrame.locator('select[name="country"]').selectOption("US");
  await cardNumber.fill(TEST_CARD.number);
  await payFrame.getByPlaceholder("MM / YY").fill(TEST_CARD.expiry);
  await payFrame.getByPlaceholder("CVC").fill(TEST_CARD.cvc);
  await payFrame.locator('input[name="postalCode"]').fill(TEST_CARD.postal);

  await page.getByRole("button", { name: /^Pay/ }).click();

  // 5) Stripe confirms and redirects to the success page, whose copy is driven by
  // the *live* intent status — "Payment received" proves a genuine test-mode charge.
  await page.waitForURL(/\/checkout\/success/);
  await expect(
    page.getByRole("heading", { name: "Payment received" }),
  ).toBeVisible();

  const paymentIntentId = new URL(page.url()).searchParams.get(
    "payment_intent",
  );
  expect(
    paymentIntentId,
    "the success URL carries the PaymentIntent id",
  ).toBeTruthy();
  if (!paymentIntentId) throw new Error("no payment_intent in the success URL");

  // 6) Pre-webhook state: the order is still PENDING and `stock` is untouched — only
  // the reservation moved. This is precisely what proves the webhook does the work.
  const pending = await readOrderByPaymentIntent(paymentIntentId);
  expect(pending.status).toBe("PENDING");
  // #135: the shipping address the form collected round-trips onto the order row,
  // written in the same transaction as order creation.
  expect(pending.shipName).toBe(ADDRESS.name);
  expect(pending.shipLine1).toBe(ADDRESS.line1);
  expect(pending.shipCity).toBe(ADDRESS.city);
  expect(pending.shipState).toBe(ADDRESS.state);
  expect(pending.shipPostalCode).toBe(ADDRESS.postalCode);
  expect(pending.shipCountry).toBe("US");
  const afterReserve = await readVariantBySku(PRODUCT.sku);
  expect(afterReserve.stock).toBe(before.stock);
  expect(afterReserve.reserved).toBe(before.reserved + 1);

  // 7) Hand-sign the `payment_intent.succeeded` Stripe would deliver and POST it to
  // the webhook. Retrieving the live intent first both sanity-checks the charge and
  // gives the event a faithful `data.object` (metadata.tenantId included).
  const paymentIntent =
    await stripeClient().paymentIntents.retrieve(paymentIntentId);
  expect(paymentIntent.status).toBe("succeeded");

  const webhookResponse = await postPaymentIntentSucceeded(
    request,
    paymentIntent,
  );
  expect(webhookResponse.status()).toBe(200);
  expect(await webhookResponse.json()).toEqual({ received: true });

  // 8) The authoritative outcome: PAID, `stock` down by the one unit bought, and the
  // reservation released (so `available = stock - reserved` fell by exactly one).
  const paid = await readOrderByPaymentIntent(paymentIntentId);
  expect(paid.status).toBe("PAID");
  const afterPaid = await readVariantBySku(PRODUCT.sku);
  expect(afterPaid.stock).toBe(before.stock - 1);
  expect(afterPaid.reserved).toBe(before.reserved);
});
