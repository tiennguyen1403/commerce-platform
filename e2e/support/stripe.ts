import Stripe from "stripe";
import type { APIRequestContext, APIResponse } from "@playwright/test";

/**
 * Node-side Stripe helpers for the checkout E2E. These run in Playwright's test
 * process (not the app), so they read `STRIPE_*` straight from `process.env` and
 * talk to Stripe test mode directly — the app's `server-only` `@/lib/stripe` can't
 * be imported here.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set for the E2E test process. The checkout spec drives real ` +
        `Stripe test mode — set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and ` +
        `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY (the CI 'e2e' job supplies them; ` +
        `locally, export them before 'pnpm test:e2e').`,
    );
  }
  return value;
}

let client: Stripe | null = null;

/**
 * A test-mode Stripe client keyed by the same secret the app server uses. The
 * default (pinned) API version is fine — this matches `@/lib/stripe`'s `new
 * Stripe(key)`, so a retrieved intent has the same shape the server sees.
 */
export function stripeClient(): Stripe {
  return (client ??= new Stripe(requireEnv("STRIPE_SECRET_KEY")));
}

/**
 * Hand-sign the `payment_intent.succeeded` event Stripe would deliver and POST it
 * to the app's webhook — the real server-to-server "paid" signal, minus the
 * network. The route's `constructEvent` only verifies the HMAC over the raw body
 * and then reads `event.type` + `data.object.{id, metadata.tenantId}`, so a minimal
 * envelope around the *real* retrieved PaymentIntent drives the true PENDING → PAID
 * path. Signed with the SDK's static signer (no API key needed); the server
 * verifies it with the same `STRIPE_WEBHOOK_SECRET` this process reads — which is
 * why that secret only has to match on both sides, not be a Stripe-registered one.
 */
export function postPaymentIntentSucceeded(
  request: APIRequestContext,
  paymentIntent: Stripe.PaymentIntent,
): Promise<APIResponse> {
  const secret = requireEnv("STRIPE_WEBHOOK_SECRET");

  const event = {
    id: `evt_e2e_${paymentIntent.id}`,
    object: "event",
    api_version: null,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    type: "payment_intent.succeeded",
    data: { object: paymentIntent },
  };
  const payload = JSON.stringify(event);

  // Static signer — no client/key required. Defaults the timestamp to now, so the
  // header comfortably passes `constructEvent`'s recency tolerance.
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
  });

  // `data` as a string is sent verbatim, so the bytes the server verifies are
  // exactly the ones we signed (JSON re-serialization would break the HMAC).
  return request.post("/api/webhooks/stripe", {
    headers: {
      "stripe-signature": signature,
      "content-type": "application/json",
    },
    data: payload,
  });
}
