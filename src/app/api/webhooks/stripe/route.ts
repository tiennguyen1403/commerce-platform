import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { env } from "@/lib/env";
import { getStripe } from "@/lib/stripe";
import { orderService } from "@/server/services/order.service";
import { outboxService } from "@/server/services/outbox.service";
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
      // The confirmation email was durably queued in the SAME transaction as
      // this PAID flip (transactional outbox, #30), so delivery no longer hinges
      // on this request. Try an immediate best-effort send for low latency;
      // whatever the outcome, the cron drain (/api/cron/dispatch-outbox) is the
      // durable retry path. This never throws, so the webhook still 200s the
      // payment regardless of the email/outbox outcome.
      await outboxService.dispatchForOrder(tenantId, result.order.id);
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

/**
 * Apply a `refund.*` event to the matching order. Stripe sends `refund.created`,
 * `refund.updated`, and `refund.failed` — all carrying a `Refund` — so we branch
 * on `refund.status`, not the event name. Only `succeeded` transitions the order
 * (PAID|FULFILLED → REFUNDED, via the service's atomic guard; the webhook is the
 * sole writer of REFUNDED). `failed` is alerted for manual follow-up — the money
 * was NOT returned — and any interim status (`pending`/`requires_action`/
 * `canceled`) is acknowledged and left for a later `refund.updated`.
 *
 * The tenant is resolved from the refund's metadata, stamped at initiation (see
 * `orderService.refundOrder`), exactly like the PaymentIntent metadata on the
 * paid path — so a refund we didn't initiate (e.g. straight from the Stripe
 * dashboard) carries none of ours and is acknowledged-and-ignored rather than
 * guessed at. Best-effort logging only; the service's guard, not this function,
 * decides whether anything actually changed.
 */
async function handleRefundEvent(
  refund: Stripe.Refund,
  log: Logger,
): Promise<void> {
  const tenantId = refund.metadata?.tenantId;
  const orderId = refund.metadata?.orderId;
  if (!tenantId) {
    log.warn(
      { refundId: refund.id },
      "refund event has no tenantId metadata; ignoring",
    );
    return;
  }

  // A Refund's `payment_intent` is `string | PaymentIntent | null` — unexpanded
  // in webhook payloads (a string id), but normalize defensively to the id we key
  // the order lookup on.
  const paymentIntentId =
    typeof refund.payment_intent === "string"
      ? refund.payment_intent
      : (refund.payment_intent?.id ?? null);

  if (refund.status === "failed") {
    // The refund did not go through — funds were NOT returned. We don't retry or
    // auto-act; surface it loudly (with the failure reason) so an operator can,
    // mirroring the oversell alert on the paid path.
    log.error(
      {
        refundId: refund.id,
        paymentIntentId,
        orderId,
        tenantId,
        failureReason: refund.failure_reason,
      },
      "REFUND FAILED: funds were not returned — manual follow-up needed",
    );
    return;
  }

  if (refund.status !== "succeeded") {
    // pending / requires_action / canceled: an interim state that doesn't move
    // the order. Acknowledge (200) so Stripe stops retrying; the terminal status
    // arrives on a later `refund.updated`.
    log.info(
      { refundId: refund.id, status: refund.status, orderId },
      "refund not in a terminal state; no-op",
    );
    return;
  }

  if (!paymentIntentId) {
    // A succeeded refund with no PaymentIntent to key on — shouldn't happen for
    // our PaymentIntent-based refunds, so surface it rather than silently drop.
    log.warn(
      { refundId: refund.id, orderId, tenantId },
      "succeeded refund has no payment_intent; cannot resolve order",
    );
    return;
  }

  const result = await orderService.markOrderRefunded(
    tenantId,
    paymentIntentId,
  );
  switch (result.outcome) {
    case "refunded":
      log.info(
        { refundId: refund.id, paymentIntentId, orderId },
        "order marked REFUNDED",
      );
      break;
    case "already-processed":
      if (result.currentStatus === "REFUNDED") {
        // Normal duplicate/late `refund.succeeded` (or a lost race) — already done.
        log.info(
          { refundId: refund.id, paymentIntentId, orderId },
          "order already REFUNDED; no-op",
        );
      } else {
        // A refund succeeded for an order we don't think was captured — anomalous.
        log.warn(
          {
            refundId: refund.id,
            paymentIntentId,
            orderId,
            currentStatus: result.currentStatus,
          },
          "refund succeeded but order is not in a refundable state; no-op",
        );
      }
      break;
    case "no-order":
      log.warn(
        { refundId: refund.id, paymentIntentId, orderId, tenantId },
        "no order matches refunded payment_intent; no-op",
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
      case "refund.created":
      case "refund.updated":
      case "refund.failed":
        // All three carry a `Refund`; the handler branches on `refund.status`.
        await handleRefundEvent(event.data.object, eventLog);
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
