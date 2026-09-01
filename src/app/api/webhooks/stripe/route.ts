import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { env } from "@/lib/env";
import { getStripe } from "@/lib/stripe";
import { orderService } from "@/server/services/order.service";
import {
  emailService,
  EmailNotConfiguredError,
} from "@/server/services/email.service";
import type { OrderWithItems } from "@/server/repositories/order.repository";
import { logger, type Logger } from "@/server/observability/logger";
import { reportError } from "@/server/observability/error-reporter";

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

/** Send the order-confirmation email without ever failing the webhook. By the
 *  time we're here the payment has already succeeded, so a Resend outage or
 *  misconfiguration must not turn this delivery into a retryable 500 — the PAID
 *  order is the durable record and the email is best-effort. Log and move on. */
async function sendConfirmationEmailSafely(
  order: OrderWithItems,
  log: Logger,
): Promise<void> {
  try {
    await emailService.sendOrderConfirmation(order);
    log.info({ orderNumber: order.orderNumber }, "confirmation email sent");
  } catch (err) {
    // Email unconfigured is an expected state (the store hasn't set up Resend),
    // not something to alarm on — log it as a warning. Any other send failure is
    // a real problem, so keep that at error level. Either way the webhook 200s.
    if (err instanceof EmailNotConfiguredError) {
      log.warn(
        { orderNumber: order.orderNumber },
        "email not configured — skipped order confirmation",
      );
      return;
    }
    // A structured error log, not `reportError`: this is best-effort email whose
    // failure is already swallowed, and a Resend outage would otherwise fan every
    // order's failure out to the alert channel. Reliable delivery (outbox +
    // retry) is issue #30's job, not this seam's.
    log.error(
      { err, orderNumber: order.orderNumber },
      "failed to send order confirmation email",
    );
  }
}

/** Move the matching Order to PAID. Best-effort logging only — the repository's
 *  guard, not this function, decides whether anything actually changed. */
async function handlePaymentIntentSucceeded(
  paymentIntent: Stripe.PaymentIntent,
  log: Logger,
): Promise<void> {
  // We stamp `tenantId` onto every PaymentIntent at checkout (see
  // order.service.ts). Without it the lookup can't be tenant-scoped
  // (golden rule #1), so acknowledge and ignore rather than guess: a foreign or
  // pre-metadata intent simply isn't one of ours to act on.
  const tenantId = paymentIntent.metadata.tenantId;
  if (!tenantId) {
    log.warn(
      { paymentIntentId: paymentIntent.id },
      "payment_intent.succeeded has no tenantId metadata; ignoring",
    );
    return;
  }

  const result = await orderService.markOrderPaid(tenantId, paymentIntent.id);
  switch (result.outcome) {
    case "paid":
      log.info(
        {
          paymentIntentId: paymentIntent.id,
          orderNumber: result.order.orderNumber,
        },
        "order marked PAID",
      );
      // Oversell alert: payment is captured, but the atomic decrement couldn't
      // fully allocate one or more lines (another shopper took the last units
      // during the payment window). We don't auto-refund/backorder yet — surface
      // it loudly with the order + shortfall detail so an operator can act. The
      // order still stands PAID (the money is real); only inventory fell short.
      if (result.shortfalls.length > 0) {
        log.error(
          {
            orderNumber: result.order.orderNumber,
            paymentIntentId: paymentIntent.id,
            shortfalls: result.shortfalls,
          },
          "OVERSELL: payment captured but stock was insufficient — manual refund/review needed",
        );
      }
      // Hang the confirmation off this single PENDING → PAID transition: only
      // this one delivery sends, so Stripe's retries never duplicate it (at
      // most once per order — a swallowed send failure is not retried).
      await sendConfirmationEmailSafely(result.order, log);
      break;
    case "already-processed":
      log.info(
        { paymentIntentId: paymentIntent.id },
        "payment_intent already processed; no-op",
      );
      break;
    case "no-order":
      // A paid intent with no order to match: shouldn't happen (the order is
      // written before checkout can confirm), so surface it rather than swallow.
      log.warn(
        { paymentIntentId: paymentIntent.id, tenantId },
        "no order matches paid payment_intent; no-op",
      );
      break;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const log = logger.child({ component: "stripe-webhook" });

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
    // A public endpoint sees these routinely (probes, a stale signing secret), so
    // it's an error-level *log*, not an alert: routine 400s don't belong in the
    // error webhook.
    log.error({ err }, "signature verification failed");
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const eventLog = log.child({ eventId: event.id, eventType: event.type });

  try {
    switch (event.type) {
      case "payment_intent.succeeded":
        await handlePaymentIntentSucceeded(event.data.object, eventLog);
        break;
      default:
        // Acknowledged but not acted on — Stripe sends many event types and a
        // 200 keeps it from retrying ones we deliberately don't handle.
        break;
    }
  } catch (err) {
    // Signature was valid but handling failed (e.g. the database was briefly
    // down). Report it — an unexpected server error the operator should see —
    // and return non-2xx so Stripe retries with backoff; the atomic status guard
    // makes that retry a safe no-op if the transition later succeeds, which is
    // what keeps this webhook a reliable source of truth.
    await reportError(err, {
      component: "stripe-webhook",
      eventId: event.id,
      eventType: event.type,
    });
    return NextResponse.json({ error: "Handler error" }, { status: 500 });
  }

  // Handled, duplicate, or ignored all resolve here — a 200 tells Stripe the
  // event was delivered so it stops retrying.
  return NextResponse.json({ received: true });
}
