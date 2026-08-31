import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { env } from "@/lib/env";
import { getStripe } from "@/lib/stripe";
import { orderService } from "@/server/services/order.service";

/**
 * Stripe webhook — the authoritative "paid" signal.
 *
 * The browser redirect after checkout is a UX convenience, not proof of payment
 * (the shopper can close the tab, and the `redirect_status` is client-supplied).
 * Stripe's server-to-server webhook is the source of truth, so this handler — not
 * the success page — is what moves an Order PENDING → PAID.
 *
 * Two things make it safe:
 *  - **Authenticity**: every event is verified with `webhooks.constructEvent`
 *    against the raw request body and the `stripe-signature` header. Only a
 *    failed verification returns 400.
 *  - **Idempotency**: Stripe retries deliveries and does not guarantee ordering,
 *    so handling leans entirely on the repository's atomic status guard rather
 *    than event timestamps. A duplicate or late event is a no-op that still 200s.
 *
 * No `runtime` export: Node is the default runtime in Next 16 and the Edge
 * Runtime is deprecated (`node_modules/next/dist/docs/01-app/03-api-reference/
 * 03-file-conventions/02-route-segment-config/runtime.md`). Node is required
 * anyway — `constructEvent` verifies the signature with Node's sync crypto.
 *
 * Local testing (Stripe CLI):
 *   stripe listen --forward-to localhost:3000/api/webhooks/stripe
 *   stripe trigger payment_intent.succeeded
 * Copy the `whsec_...` the listener prints into `STRIPE_WEBHOOK_SECRET`.
 */

/** Move the matching Order to PAID. Best-effort logging only — the repository's
 *  guard, not this function, decides whether anything actually changed. */
async function handlePaymentIntentSucceeded(
  paymentIntent: Stripe.PaymentIntent,
): Promise<void> {
  // We stamp `tenantId` onto every PaymentIntent at checkout (see
  // order.service.ts). Without it the lookup can't be tenant-scoped
  // (golden rule #1), so acknowledge and ignore rather than guess: a foreign or
  // pre-metadata intent simply isn't one of ours to act on.
  const tenantId = paymentIntent.metadata.tenantId;
  if (!tenantId) {
    console.warn(
      `Stripe webhook: payment_intent.succeeded ${paymentIntent.id} has no tenantId metadata; ignoring`,
    );
    return;
  }

  const { outcome } = await orderService.markOrderPaid(
    tenantId,
    paymentIntent.id,
  );
  switch (outcome) {
    case "paid":
      console.info(
        `Stripe webhook: order for PaymentIntent ${paymentIntent.id} marked PAID`,
      );
      break;
    case "already-processed":
      console.info(
        `Stripe webhook: PaymentIntent ${paymentIntent.id} already processed; no-op`,
      );
      break;
    case "no-order":
      // A paid intent with no order to match: shouldn't happen (the order is
      // written before checkout can confirm), so surface it rather than swallow.
      console.warn(
        `Stripe webhook: no order matches paid PaymentIntent ${paymentIntent.id} for tenant ${tenantId}; no-op`,
      );
      break;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  // Verify against the exact bytes Stripe signed: read the body as raw text and
  // never parse it as JSON first, which would re-serialize it and break the HMAC.
  const rawBody = await request.text();

  // Build the client outside the try so a missing-key config error can't be
  // mislabeled as a 400 — inside the try, only a signature failure is caught.
  const stripe = getStripe();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    // Bad/forged signature or malformed payload — the only case that is a 400.
    console.error("Stripe webhook signature verification failed", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "payment_intent.succeeded":
        await handlePaymentIntentSucceeded(event.data.object);
        break;
      default:
        // Acknowledged but not acted on — Stripe sends many event types and a
        // 200 keeps it from retrying ones we deliberately don't handle.
        break;
    }
  } catch (err) {
    // Signature was valid but handling failed (e.g. the database was briefly
    // down). Return non-2xx so Stripe retries with backoff; the atomic status
    // guard makes that retry a safe no-op if the transition later succeeds,
    // which is what keeps this webhook a reliable source of truth.
    console.error(
      `Stripe webhook: handler failed for ${event.type} (${event.id})`,
      err,
    );
    return NextResponse.json({ error: "Handler error" }, { status: 500 });
  }

  // Handled, duplicate, or ignored all resolve here — a 200 tells Stripe the
  // event was delivered so it stops retrying.
  return NextResponse.json({ received: true });
}
