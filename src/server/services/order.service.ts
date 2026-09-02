import "server-only";
import { randomInt, randomUUID } from "node:crypto";
import type Stripe from "stripe";
import type { OrderStatus } from "@prisma/client";
import { getStripe } from "@/lib/stripe";
import { cartService, type CartView } from "@/server/services/cart.service";
import {
  orderRepository,
  type CreateOrderInput,
  type ListOrdersParams,
  type OrdersPage,
  type OrderWithItems,
  type StalePendingOrder,
  type StockShortfall,
} from "@/server/repositories/order.repository";
import {
  EmptyCartError,
  OrderNumberTakenError,
  OrderNotFoundError,
  OrderTransitionError,
} from "@/server/order.errors";
import { logger } from "@/server/observability/logger";
import type { CartLine } from "@/lib/cart";

/**
 * Checkout business logic. Turns a cookie's `{ variantId, qty }[]` into a
 * PaymentIntent + a PENDING order with snapshotted line items. Price is the
 * security boundary: totals and per-line prices come from a fresh variant read
 * via the cart service (never the cookie/client), so a tampered cart can name
 * items but can't move money. Stays free of Prisma (the repository owns that);
 * it does own the Stripe call, since that's a checkout concern, not persistence.
 *
 * "Paid" is deliberately NOT set here — the order lands as PENDING and the
 * Stripe webhook (#14) owns the PENDING → PAID transition.
 */

// Re-export so the Server Action boundary imports checkout + lifecycle errors
// from one place.
export {
  EmptyCartError,
  InsufficientStockError,
  OrderNotFoundError,
  OrderTransitionError,
} from "@/server/order.errors";

export type StartCheckoutResult = {
  clientSecret: string;
  orderId: string;
  orderNumber: string;
  totalCents: number;
  currency: string;
};

export type CheckoutResult = {
  /** The PaymentIntent's live status — authoritative for the success-page copy. */
  status: Stripe.PaymentIntent.Status;
  /** The persisted order (with items), or null if it can't be found. */
  order: Awaited<
    ReturnType<typeof orderRepository.findByPaymentIntentForTenant>
  >;
};

/** Result of confirming payment from a webhook (see `markOrderPaid`). `"paid"`
 *  carries the newly-paid order (for the confirmation email) and any oversell
 *  `shortfalls` the atomic stock decrement couldn't fill. */
export type MarkOrderPaidResult =
  | { outcome: "paid"; order: OrderWithItems; shortfalls: StockShortfall[] }
  | { outcome: "already-processed" | "no-order" };

/** Result of applying a refund from a verified `refund.*` webhook (see
 *  `markOrderRefunded`), reported three ways so the webhook can log each case
 *  distinctly: `"refunded"` — this delivery made the PAID|FULFILLED → REFUNDED
 *  transition; `"already-processed"` — an order exists but wasn't in a refundable
 *  state (carries its `currentStatus`, so a normal duplicate that's already
 *  REFUNDED reads apart from an anomaly like a refund on a still-PENDING order);
 *  `"no-order"` — no order matches this PaymentIntent for the tenant. */
export type MarkOrderRefundedResult =
  | { outcome: "refunded" }
  | { outcome: "already-processed"; currentStatus: OrderStatus }
  | { outcome: "no-order" };

/** Per-run tallies from the abandoned-PENDING sweep (#25), surfaced by the cron
 *  route for observability. */
export type SweepResult = {
  /** Abandoned orders transitioned PENDING → CANCELLED this run (intent cancelled,
   *  reservation released). */
  swept: number;
  /** Stale orders deliberately left untouched: payment in flight/captured, a lost
   *  race, an unreadable intent, or an unexpected intent status. */
  skipped: number;
  /** Orders whose sweep hit an unexpected error (isolated so one can't abort the
   *  batch); left PENDING and retried next run. */
  errored: number;
};

// Human-friendly, unambiguous order-number suffix: no 0/1/I/O to misread.
const ORDER_NUMBER_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const ORDER_NUMBER_SUFFIX_LEN = 6;
// Bound the retry so a pathological collision streak can't loop forever; with a
// per-day-per-tenant keyspace of 31^6 (~887M) it effectively never recurs.
const MAX_ORDER_NUMBER_ATTEMPTS = 5;

/** `YYYYMMDD-XXXXXX` — a UTC date prefix for at-a-glance sorting plus a random,
 *  collision-resistant suffix. Uniqueness is enforced per tenant by the DB. */
function generateOrderNumber(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  let suffix = "";
  for (let i = 0; i < ORDER_NUMBER_SUFFIX_LEN; i++) {
    suffix += ORDER_NUMBER_ALPHABET[randomInt(ORDER_NUMBER_ALPHABET.length)];
  }
  return `${date}-${suffix}`;
}

/** Persist the order, retrying with a fresh order number on the (rare) unique
 *  collision. Any other failure — or an exhausted retry budget — propagates. */
async function createOrderWithRetry(
  input: Omit<CreateOrderInput, "orderNumber">,
) {
  for (let attempt = 1; attempt <= MAX_ORDER_NUMBER_ATTEMPTS; attempt++) {
    try {
      return await orderRepository.createWithItems({
        ...input,
        orderNumber: generateOrderNumber(),
      });
    } catch (err) {
      if (
        err instanceof OrderNumberTakenError &&
        attempt < MAX_ORDER_NUMBER_ATTEMPTS
      ) {
        continue;
      }
      throw err;
    }
  }
  // Unreachable: the final attempt either returns or throws.
  throw new OrderNumberTakenError();
}

/** Cancel an orphaned PaymentIntent after a failed order write. Best-effort: an
 *  uncancelled, unconfirmed intent simply expires, so failure here is swallowed. */
async function cancelPaymentIntentQuietly(
  paymentIntentId: string,
): Promise<void> {
  try {
    await getStripe().paymentIntents.cancel(paymentIntentId);
  } catch {
    // Intentionally ignored.
  }
}

/** Translate a refused order transition into the right typed error for the
 *  action boundary: no such order → `OrderNotFoundError`; wrong source state →
 *  `OrderTransitionError` naming the order's current (lowercased) status, e.g.
 *  "This order can't be cancelled because its status is paid." */
function failTransition(
  action: string,
  currentStatus: OrderStatus | null,
): never {
  if (currentStatus === null) throw new OrderNotFoundError();
  throw new OrderTransitionError(
    `This order can't be ${action} because its status is ${currentStatus.toLowerCase()}.`,
  );
}

// --- Abandoned-checkout dedupe & sweep tuning (#25) --------------------------
// Module-local knobs, matching outbox.service's tuning-constant style.

/** How old a still-`PENDING` order must be before the sweep treats it as an
 *  abandoned checkout and cancels it. Comfortably longer than any real payment
 *  session; a shopper who re-submits does so within minutes, and the reuse path
 *  (a strictly shorter window) collapses those before they ever become stale. */
const PENDING_SWEEP_AFTER_MS = 30 * 60_000; // 30 minutes

/** Upper bound on stale orders pulled per sweep run. The real stop condition is
 *  the time budget below (each order makes 1–2 Stripe calls, run sequentially);
 *  this just caps the query so one run can't load an unbounded backlog into
 *  memory. Whatever isn't reached drains over later runs — the sweep is
 *  reconciliation-based, so a partial run is always safe. */
const SWEEP_BATCH_SIZE = 100;

/** Soft per-run wall-clock budget. The sweep stops starting new orders once this
 *  elapses, so a slow Stripe (or a big backlog) degrades into "continues next run"
 *  rather than being force-killed at the route's `maxDuration` (60s) mid-cancel.
 *  Kept comfortably under `maxDuration` (mirrors the outbox drain's budget). */
const SWEEP_TIME_BUDGET_MS = 45_000;

/** How recent a `PENDING` order may be to be *reused* on a re-submit. Strictly
 *  shorter than `PENDING_SWEEP_AFTER_MS`, so a reused order always has a wide
 *  margin before it becomes sweep-eligible — a shopper who reuses it and then pays
 *  is never racing the sweep. */
const PENDING_REUSE_WINDOW_MS = 15 * 60_000; // 15 minutes

/** How many recent candidates the dedupe read pulls. A shopper has at most a
 *  handful of in-flight attempts for one cart, and the newest match wins. */
const REUSE_CANDIDATE_LIMIT = 5;

/** A PaymentIntent is reusable only while it is still awaiting a payment method or
 *  confirmation — i.e. no charge has been attempted (per issue #25). Every other
 *  status (processing/succeeded/requires_action/canceled) means payment is in
 *  flight, captured, or dead, and must never be re-handed to a new Payment Element. */
const REUSABLE_PI_STATUSES = new Set<Stripe.PaymentIntent.Status>([
  "requires_payment_method",
  "requires_confirmation",
]);

/** In-flight PI statuses that are routine to meet mid-sweep (a payment genuinely in
 *  progress) — the sweep logs these at info. `succeeded` (webhook lag) and any other
 *  non-cancellable status (a cancel that lost the race, or an unknown one) are noisier
 *  signals the sweep logs at error/warn instead. */
const EXPECTED_IN_FLIGHT_STATUSES = new Set<Stripe.PaymentIntent.Status>([
  "processing",
  "requires_capture",
  "requires_action",
]);

const sweepLog = logger.child({ component: "order-sweep" });

/** Aggregate a set of lines into `variantId → total quantity`, so two carts with
 *  the same contents compare equal regardless of line order or how quantities are
 *  split across duplicate lines. */
function lineCounts(
  lines: Array<{ variantId: string; quantity: number }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    counts.set(
      line.variantId,
      (counts.get(line.variantId) ?? 0) + line.quantity,
    );
  }
  return counts;
}

/** Does this PENDING order's line-set match the re-priced cart exactly — same
 *  variants, same per-variant quantities? Currency and total are already matched by
 *  the repository query; this is the remaining structural check before reuse. */
function orderMatchesCart(order: OrderWithItems, cart: CartView): boolean {
  const cartCounts = lineCounts(
    cart.items.map((item) => ({
      variantId: item.variantId,
      quantity: item.qty,
    })),
  );
  const orderCounts = lineCounts(order.items);
  if (cartCounts.size !== orderCounts.size) return false;
  for (const [variantId, quantity] of cartCounts) {
    if (orderCounts.get(variantId) !== quantity) return false;
  }
  return true;
}

/**
 * Try to reuse an in-flight PaymentIntent instead of minting a new one (#25). A
 * shopper who submits, hits an error or *Back to cart*, then submits the same cart
 * again used to create a *second* PENDING order + chargeable-shaped PaymentIntent
 * (and a second inventory hold); this collapses that. Looks for a recent PENDING
 * order for this tenant + caller identity whose currency, total, and line-set match
 * the freshly-repriced cart, then confirms the linked PaymentIntent is still
 * awaiting payment (and its amount/currency still match) before handing back its
 * existing client secret. Returns null — meaning "create a fresh intent" — on any
 * miss: no candidate, a line-set mismatch, an unreadable or non-reusable intent, or
 * a drifted amount.
 *
 * Identity is the security boundary for *who* may reuse an intent (#92): a signed-in
 * shopper (`userId !== null`) is matched on the session-proven `userId` — never the
 * client-supplied `email`, which anyone could type; a guest (`userId === null`) stays
 * email-keyed but is pinned to `userId: null`, so a guest can't reuse a signed-in
 * shopper's in-flight intent by supplying their email. Price stays the security
 * boundary for *how much*: the match is against the re-priced cart
 * (`cart.totalCents`), never a stored total.
 */
async function tryReuseInFlightIntent(
  tenantId: string,
  userId: string | null,
  email: string,
  cart: CartView,
): Promise<StartCheckoutResult | null> {
  const filters = {
    tenantId,
    totalCents: cart.totalCents,
    currency: cart.currency,
    createdAfter: new Date(Date.now() - PENDING_REUSE_WINDOW_MS),
    limit: REUSE_CANDIDATE_LIMIT,
  };
  const candidates = await orderRepository.findReusablePendingCandidates(
    // Bind reuse to identity (#92): an authenticated shopper matches on the
    // session-proven `userId` (never the client-supplied email); a guest stays
    // email-keyed but pinned to `userId: null`. Two complete literals, one per arm
    // of the identity union, so the trust boundary holds at the type level too.
    userId !== null
      ? { ...filters, userId }
      : { ...filters, userId: null, email },
  );

  const stripe = getStripe();
  for (const candidate of candidates) {
    if (!candidate.stripePaymentIntentId) continue;
    if (!orderMatchesCart(candidate, cart)) continue;

    let paymentIntent: Stripe.PaymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.retrieve(
        candidate.stripePaymentIntentId,
      );
    } catch {
      // The intent is unreadable (unknown/deleted at Stripe) — not reusable. Try
      // the next candidate; if none qualify, checkout falls through to a fresh create.
      continue;
    }

    // Reuse only an intent still awaiting payment AND whose amount + currency still
    // equal the re-priced cart — a belt-and-suspenders re-check on top of the DB
    // total match, guarding against any drift between the order row and its intent.
    if (
      REUSABLE_PI_STATUSES.has(paymentIntent.status) &&
      paymentIntent.amount === cart.totalCents &&
      paymentIntent.currency === cart.currency &&
      paymentIntent.client_secret
    ) {
      return {
        clientSecret: paymentIntent.client_secret,
        orderId: candidate.id,
        orderNumber: candidate.orderNumber,
        totalCents: candidate.totalCents,
        currency: candidate.currency,
      };
    }
    // Not reusable (captured/capturing/canceled, or a drifted amount). Fall through
    // deliberately: we never re-hand a non-awaiting intent to the Payment Element.
    // The rare case is a captured intent whose PENDING → PAID webhook is still
    // lagging — reusing an older awaiting intent for the same cart could double-book
    // it, but so would the fresh create below, so this is no worse than the
    // pre-dedupe behaviour. True "already paid" detection is out of scope here.
  }
  return null;
}

/** Outcome of sweeping one order: `"swept"` — cancelled + hold released this run;
 *  `"skipped"` — deliberately left (payment in flight/captured, a lost race, an
 *  unreadable intent, or an unexpected intent status). */
type SweepOutcome = "swept" | "skipped";

/** Best-effort PaymentIntent cancel that REPORTS whether the intent ended up
 *  `canceled` — unlike `cancelPaymentIntentQuietly`, whose result the caller
 *  ignores. The sweep needs the signal: it may flip an order to CANCELLED only once
 *  its intent is provably `canceled` (money can only be captured on a non-canceled
 *  intent), so a cancel that instead lost the race to a real payment must not
 *  green-light the DB flip. Returns true iff the intent is now `canceled`. */
async function cancelPaymentIntentReporting(
  paymentIntentId: string,
): Promise<boolean> {
  try {
    const canceled = await getStripe().paymentIntents.cancel(paymentIntentId);
    return canceled.status === "canceled";
  } catch {
    // Cancel failed: the intent moved out of the cancellable window (the shopper
    // just paid → processing/succeeded) or was canceled elsewhere. Either way we
    // can't assert it's canceled, so the caller must leave the order PENDING.
    return false;
  }
}

/** How a PENDING order's PaymentIntent stands relative to being safely retired.
 *  Money is captured on the intent, not the order row, so an order is flipped to
 *  CANCELLED only when its intent is provably `canceled`. Shared by the abandoned
 *  sweep (#25) and the admin cancel (#81), which act on the verdict differently
 *  (skip-and-log vs. refuse-with-a-typed-error). */
type PaymentIntentDisposition =
  /** Now `canceled` (it already was, or this call canceled it) — no charge can land,
   *  so the order may be flipped to CANCELLED. */
  | { kind: "canceled" }
  /** Payment is captured, capturing, or authenticating — or a cancel just lost the
   *  race to one — so the intent is NOT canceled and the order must be left for the
   *  webhook (#14). `status` is the last-known intent status, for the caller's
   *  log/message. */
  | { kind: "payment-in-flight"; status: Stripe.PaymentIntent.Status }
  /** The intent couldn't be read (unknown/deleted, or Stripe unreachable), so its
   *  state can't be verified — the caller must not cancel blindly. */
  | { kind: "unreadable" };

/**
 * Retire a PENDING order's chargeable PaymentIntent as far as is money-safe, and
 * report the disposition. Retrieves the intent, then:
 *  - captured/capturing/authenticating (`succeeded`/`processing`/`requires_capture`/
 *    `requires_action`) → `payment-in-flight` — never cancel a paying/paid intent;
 *  - `canceled` → `canceled` — already retired; reconcile the order, no cancel call;
 *  - `requires_payment_method`/`requires_confirmation` → cancel it, then `canceled`
 *    if the cancel took, else `payment-in-flight` (it raced a real payment);
 *  - an unknown/future status → `payment-in-flight` — never cancel what we can't
 *    classify;
 *  - unreadable → `unreadable`.
 * The caller flips the order to CANCELLED only on `canceled`. This is the single
 * money-safe primitive behind both the sweep and the admin cancel.
 */
async function disposeChargeableIntent(
  paymentIntentId: string,
): Promise<PaymentIntentDisposition> {
  let paymentIntent: Stripe.PaymentIntent;
  try {
    paymentIntent = await getStripe().paymentIntents.retrieve(paymentIntentId);
  } catch {
    return { kind: "unreadable" };
  }

  switch (paymentIntent.status) {
    // Captured, capturing, or awaiting customer authentication (3DS) — payment is in
    // flight or done; the webhook owns it. Never cancel.
    case "succeeded":
    case "processing":
    case "requires_capture":
    case "requires_action":
      return { kind: "payment-in-flight", status: paymentIntent.status };

    // Already retired at Stripe (a prior sweep/cancel canceled the intent but didn't
    // finish the DB flip, or it was canceled in the dashboard) — reconcile only.
    case "canceled":
      return { kind: "canceled" };

    // Abandoned and still chargeable: cancel it, and report `canceled` only if the
    // cancel confirms it took. A cancel that lost the race to a real payment comes
    // back false → `payment-in-flight`, so the order is left for the webhook.
    case "requires_payment_method":
    case "requires_confirmation": {
      const canceled = await cancelPaymentIntentReporting(paymentIntentId);
      return canceled
        ? { kind: "canceled" }
        : { kind: "payment-in-flight", status: paymentIntent.status };
    }

    // An unknown/future status we can't classify — treat as in-flight and never
    // cancel/flip it.
    default:
      return { kind: "payment-in-flight", status: paymentIntent.status };
  }
}

/**
 * Sweep one abandoned-checkout order (#25). The DB flip
 * (`cancelPendingAndRelease`) is the arbiter of the order's terminal state —
 * atomic and guarded on `PENDING`, so a racing webhook PENDING → PAID always wins
 * cleanly and we no-op. But money is captured on the *PaymentIntent*, not the row,
 * so the order is flipped to CANCELLED only once its intent is provably `canceled`.
 * Anything that shows payment in flight or captured is left for the webhook (#14) —
 * the sole writer of PAID — to resolve.
 */
async function sweepOne(order: StalePendingOrder): Promise<SweepOutcome> {
  // Reconcile-and-release, run only once we know no charge can land.
  // `cancelPendingAndRelease` is the same guarded PENDING → CANCELLED + reservation
  // release the admin cancel uses; a lost race (already PAID/CANCELLED) comes back
  // transitioned:false → reported as skipped.
  const flip = async (): Promise<SweepOutcome> => {
    const result = await orderRepository.cancelPendingAndRelease(
      order.tenantId,
      order.id,
    );
    return result.transitioned ? "swept" : "skipped";
  };

  // A checkout order should always link a PaymentIntent; one without is a data
  // anomaly. We can't verify Stripe state, but the order is abandoned and still
  // holds inventory, so release it — the guard keeps this safe if it isn't PENDING.
  if (!order.stripePaymentIntentId) {
    sweepLog.warn(
      { orderId: order.id, tenantId: order.tenantId },
      "sweep: PENDING order has no PaymentIntent; cancelling and releasing hold",
    );
    return flip();
  }

  const disposition = await disposeChargeableIntent(
    order.stripePaymentIntentId,
  );
  switch (disposition.kind) {
    // The intent can no longer be charged (we canceled it, or it already was) —
    // reconcile the order. The guarded flip no-ops if a racing webhook won → skipped.
    case "canceled":
      return flip();

    // Couldn't read/cancel the intent (unknown/deleted, or Stripe down) — can't prove
    // it's uncharged, so leave the order for a later run rather than cancel blindly.
    case "unreadable":
      sweepLog.warn(
        { orderId: order.id, paymentIntentId: order.stripePaymentIntentId },
        "sweep: could not retrieve/cancel PaymentIntent; leaving order for a later run",
      );
      return "skipped";

    // Payment is in flight or captured — never cancel. Log severity tracks how
    // surprising the status is: a *succeeded* intent whose order is still PENDING
    // past the grace window means the webhook is lagging or was lost (error); a
    // genuinely in-progress payment is routine (info); anything else — a cancel that
    // lost the race to a real payment (a `requires_*` status survived the cancel), or
    // an unrecognised Stripe status — is a near-miss worth eyeballing (warn).
    case "payment-in-flight":
      if (disposition.status === "succeeded") {
        sweepLog.error(
          {
            orderId: order.id,
            paymentIntentId: order.stripePaymentIntentId,
            tenantId: order.tenantId,
          },
          "sweep: PaymentIntent SUCCEEDED but order still PENDING — webhook may be lost; NOT cancelling",
        );
      } else if (EXPECTED_IN_FLIGHT_STATUSES.has(disposition.status)) {
        sweepLog.info(
          {
            orderId: order.id,
            paymentIntentId: order.stripePaymentIntentId,
            status: disposition.status,
          },
          "sweep: payment in progress; leaving order for the webhook",
        );
      } else {
        sweepLog.warn(
          {
            orderId: order.id,
            paymentIntentId: order.stripePaymentIntentId,
            status: disposition.status,
          },
          "sweep: intent not cancellable (cancel raced a payment, or unexpected status); leaving order for the webhook",
        );
      }
      return "skipped";
  }
}

export const orderService = {
  /**
   * Begin checkout: reconcile the cart against live variants, create a Stripe
   * PaymentIntent for the recomputed total, then write a PENDING order + its
   * snapshotted items in one transaction (with the PaymentIntent linked). The
   * order id is pre-generated so it can ride in the PaymentIntent's metadata
   * while the row is written with the intent id in a single write. Returns the
   * `clientSecret` the browser needs to mount the Payment Element.
   *
   * Before minting anything, it tries to **reuse an in-flight intent** (#25): a
   * re-submit of a cart already awaiting payment hands back the existing intent's
   * client secret instead of creating a second PENDING order + chargeable intent.
   * The reuse match is against the freshly re-priced cart, never a stored total.
   */
  async startCheckout(
    tenantId: string,
    lines: CartLine[],
    email: string,
    currency: string,
    userId: string | null,
  ): Promise<StartCheckoutResult> {
    const cart = await cartService.getCartView(tenantId, lines, currency);
    if (cart.items.length === 0) throw new EmptyCartError();

    // Dedupe: if this looks like a re-submit of a cart already in flight, reuse the
    // existing intent rather than minting a second PENDING order + chargeable
    // PaymentIntent (and a second inventory hold). A miss just falls through to a
    // fresh create; the sweep below is the safety net for anything left abandoned.
    // Reuse is bound to identity (#92): a signed-in shopper matches on the
    // session-proven `userId`, a guest on `userId: null` + email — so a guest can't
    // hand back a signed-in shopper's in-flight intent by typing their email.
    const reused = await tryReuseInFlightIntent(tenantId, userId, email, cart);
    if (reused) return reused;

    const orderId = randomUUID();
    const stripe = getStripe();

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: cart.totalCents,
        currency: cart.currency,
        // The webhook (#14) reads these to flip PENDING → PAID and scope the
        // tenant; they also make the charge traceable in the Stripe dashboard.
        metadata: { orderId, tenantId },
        receipt_email: email,
        automatic_payment_methods: { enabled: true },
      },
      // Same key across a network retry of this exact call → at most one intent.
      { idempotencyKey: orderId },
    );

    if (!paymentIntent.client_secret) {
      await cancelPaymentIntentQuietly(paymentIntent.id);
      throw new Error("Stripe did not return a client secret");
    }

    const items = cart.items.map((item) => ({
      variantId: item.variantId,
      // Snapshot the readable name so later catalog edits never rewrite history.
      titleSnapshot: `${item.productTitle} — ${item.variantName}`,
      priceCents: item.unitPriceCents,
      quantity: item.qty,
    }));

    try {
      const order = await createOrderWithRetry({
        id: orderId,
        tenantId,
        email,
        // Server-resolved from the session at the action boundary, threaded down
        // — never client-supplied. Links a signed-in shopper's order to their
        // global `User`; a guest's stays null (#102).
        userId,
        totalCents: cart.totalCents,
        currency: cart.currency,
        stripePaymentIntentId: paymentIntent.id,
        items,
      });
      return {
        clientSecret: paymentIntent.client_secret,
        orderId: order.id,
        orderNumber: order.orderNumber,
        totalCents: order.totalCents,
        currency: order.currency,
      };
    } catch (err) {
      // Order write failed (collisions exhausted, DB down, …). Cancel the now
      // orphaned intent so no chargeable PaymentIntent is left without an order.
      await cancelPaymentIntentQuietly(paymentIntent.id);
      throw err;
    }
  },

  /**
   * Resolve a checkout result for the success page. The PaymentIntent id and
   * client secret both arrive as URL params on Stripe's redirect; the id alone
   * is not proof of ownership (it can leak via Referer/history/logs), so we
   * retrieve the intent and require its `client_secret` to match the one from
   * the URL before returning any order detail. The intent's live `status` is the
   * source of truth for the page copy — not the client-supplied `redirect_status`.
   * Returns null when the id is unknown or the secret doesn't match.
   */
  async getCheckoutResult(
    tenantId: string,
    paymentIntentId: string,
    clientSecret: string,
  ): Promise<CheckoutResult | null> {
    let paymentIntent: Stripe.Response<Stripe.PaymentIntent>;
    try {
      paymentIntent =
        await getStripe().paymentIntents.retrieve(paymentIntentId);
    } catch {
      // Unknown or malformed PaymentIntent id.
      return null;
    }

    // The client secret is handed only to the browser that created the intent,
    // so matching it is what authorizes showing the order's (PII-bearing) detail.
    if (
      !paymentIntent.client_secret ||
      paymentIntent.client_secret !== clientSecret
    ) {
      return null;
    }

    const order = await orderRepository.findByPaymentIntentForTenant(
      tenantId,
      paymentIntentId,
    );
    return { status: paymentIntent.status, order };
  },

  /**
   * Confirm payment for an order from a verified Stripe webhook: atomically move
   * it PENDING → PAID and decrement its lines' stock (the repository does both in
   * one transaction). This — not the browser redirect — is the source of truth
   * for "paid." Idempotency lives in the repository's atomic status guard, so
   * calling this for a duplicate/late event (or an unknown PaymentIntent) is a
   * safe no-op that neither re-emails nor double-decrements. The outcome is
   * reported three ways so the webhook can log each distinctly:
   *  - `"paid"` — this delivery made the PENDING → PAID transition. It carries
   *    the confirmed `order` (with items) — the single moment the confirmation
   *    email (#15) hangs off — plus `shortfalls`: any line whose stock couldn't
   *    cover it at capture (an oversell). The order still stands PAID; the
   *    shortfalls are for the webhook to flag for manual refund/review. Only this
   *    one delivery reports "paid", so Stripe's retries never duplicate it.
   *  - `"already-processed"` — the order exists but was past PENDING already
   *    (a normal duplicate/late delivery); nothing to do, no stock touched.
   *  - `"no-order"` — no order matches this PaymentIntent for the tenant. The
   *    order is written before the client can confirm, so a genuinely paid
   *    intent should always have one; this signals data drift worth a warning.
   */
  async markOrderPaid(
    tenantId: string,
    paymentIntentId: string,
  ): Promise<MarkOrderPaidResult> {
    const result = await orderRepository.markPaidByPaymentIntent(
      tenantId,
      paymentIntentId,
    );

    if (result.transitioned) {
      // This delivery flipped the order to PAID and allocated its stock in one
      // transaction; `order` is what we email, `shortfalls` any oversell to flag.
      return {
        outcome: "paid",
        order: result.order,
        shortfalls: result.shortfalls,
      };
    }

    // Nothing moved, and the repository already told us which case from inside
    // its transaction: a normal duplicate/late delivery (order past PENDING) or
    // — anomalously — no order for this intent. No second read, no stock touched.
    return {
      outcome: result.orderExisted ? "already-processed" : "no-order",
    };
  },

  /**
   * A tenant's orders for the admin list — newest first, optionally filtered to a
   * single `status`, paginated. A thin pass-through to the tenant-scoped
   * repository read (the admin page calls the service, never Prisma, per the
   * layering rule); the calling boundary zod-validates `status`/`page` first.
   */
  async listOrders(
    tenantId: string,
    params: ListOrdersParams,
  ): Promise<OrdersPage> {
    return orderRepository.listByTenant(tenantId, params);
  },

  /**
   * One order with its line items for the admin detail page, scoped to the
   * tenant — or null when no such order exists for it (the page maps that to a
   * real 404). Thin pass-through to the repository, keeping pages off Prisma.
   */
  async getOrder(
    tenantId: string,
    orderId: string,
  ): Promise<OrderWithItems | null> {
    return orderRepository.findByIdForTenant(tenantId, orderId);
  },

  /**
   * Cancel a PENDING order (admin action): retire its Stripe PaymentIntent, release
   * its inventory hold, and move it to CANCELLED.
   *
   * Money-safety (#81): the order's PaymentIntent is left chargeable until this runs,
   * so cancelling the order without cancelling the intent could strand a shopper who
   * pays in the window before the webhook flips PENDING → PAID — capturing funds
   * against a CANCELLED order. So the intent is retired FIRST (money is captured on
   * the intent, not the row) and the order is flipped only once the intent is
   * provably `canceled` (`disposeChargeableIntent`, the same primitive the sweep
   * uses). If payment is in flight or captured, the cancel is REFUSED with an
   * `OrderTransitionError` — the webhook stays the sole writer of PAID, and the admin
   * can refresh and refund once it lands.
   *
   * The repository's guarded `cancelPendingAndRelease` remains the authoritative
   * arbiter of the flip (its `status: PENDING` guard turns any race into a no-op).
   * Translates a no-op / bad state into a typed error the action boundary maps to a
   * message — `OrderNotFoundError` (no such order) or `OrderTransitionError` (not
   * PENDING: already paid/cancelled/fulfilled, or a payment is completing).
   *
   * This is a STAFF+ operation. The role is enforced by the calling admin Server
   * Action with `assertRole(ROLES.STAFF)` before it calls in — services stay
   * role-agnostic and tenant-scoped, matching the codebase's boundary-gating
   * pattern (see membership.service).
   */
  async cancelOrder(tenantId: string, orderId: string): Promise<void> {
    // Pre-read to get the linked PaymentIntent and fail fast on an absent / non-PENDING
    // order before any Stripe call. The guarded transition below is still authoritative.
    const order = await orderRepository.findByIdForTenant(tenantId, orderId);
    if (!order) throw new OrderNotFoundError();
    if (order.status !== "PENDING") failTransition("cancelled", order.status);

    if (order.stripePaymentIntentId) {
      const disposition = await disposeChargeableIntent(
        order.stripePaymentIntentId,
      );
      if (disposition.kind === "payment-in-flight") {
        // The shopper is completing (or just completed) payment in the window before
        // the webhook flips PENDING → PAID. Refuse rather than cancel a paying/paid
        // order; the webhook stays the sole writer of PAID.
        throw new OrderTransitionError(
          "This order can't be cancelled because a payment is being completed. Refresh in a moment to see its updated status.",
        );
      }
      if (disposition.kind === "unreadable") {
        // Couldn't verify the intent (Stripe unreachable / unknown intent). Don't
        // cancel an order whose payment state we can't confirm — surface it; retry.
        throw new Error(
          `Could not verify the PaymentIntent for order ${orderId}; cancel not applied.`,
        );
      }
      // disposition.kind === "canceled": the intent can no longer be charged — safe
      // to flip the order below.
    }

    const result = await orderRepository.cancelPendingAndRelease(
      tenantId,
      orderId,
    );
    if (!result.transitioned) failTransition("cancelled", result.currentStatus);
  },

  /**
   * Mark a PAID order FULFILLED (admin action): a manual status attestation only
   * — no shipping address, no provider call (that's M4). Delegates the atomic
   * guarded transition to the repository and translates a no-op into
   * `OrderNotFoundError` (no such order) or `OrderTransitionError` (it exists but
   * isn't PAID). STAFF+, gated by the calling Server Action as above.
   */
  async fulfillOrder(tenantId: string, orderId: string): Promise<void> {
    const result = await orderRepository.markFulfilled(tenantId, orderId);
    if (!result.transitioned) {
      failTransition("marked fulfilled", result.currentStatus);
    }
  },

  /**
   * Initiate a full refund for a captured order (admin action): look up the
   * order, verify it's refundable (PAID or FULFILLED), and ask Stripe to refund
   * its PaymentIntent in full (`amount` omitted). Stamps `{ tenantId, orderId }`
   * on the refund so the `refund.*` webhook can flip the order to REFUNDED and
   * scope the tenant — exactly as the PaymentIntent metadata drives PENDING →
   * PAID at checkout.
   *
   * Makes NO database write: the verified webhook is the SOLE writer of REFUNDED,
   * so status only moves once Stripe confirms the money was actually returned
   * (initiation succeeding is not the refund succeeding). A refused state maps to
   * the same typed errors as the other transitions — `OrderNotFoundError` (no
   * such order) or `OrderTransitionError` naming the current status (it exists
   * but isn't PAID/FULFILLED: still pending, cancelled, or already refunded).
   *
   * This is an ADMIN+ operation. The role is enforced by the calling admin Server
   * Action with `assertRole(ROLES.ADMIN)` before it calls in — services stay
   * role-agnostic and tenant-scoped, matching cancel/fulfil above. The admin
   * orders UI that wires this action lands with #58; this is its tested backend.
   */
  async refundOrder(tenantId: string, orderId: string): Promise<void> {
    const order = await orderRepository.findByIdForTenant(tenantId, orderId);
    if (!order) throw new OrderNotFoundError();
    if (order.status !== "PAID" && order.status !== "FULFILLED") {
      // Reuse the shared refusal message ("…because its status is X").
      failTransition("refunded", order.status);
    }

    const { stripePaymentIntentId } = order;
    if (!stripePaymentIntentId) {
      // Every checkout links a PaymentIntent, so a captured order without one is
      // a data anomaly we can't refund through Stripe — surface it, don't guess.
      throw new Error(
        `Order ${orderId} is ${order.status} but has no linked PaymentIntent; cannot refund.`,
      );
    }

    await getStripe().refunds.create(
      {
        payment_intent: stripePaymentIntentId,
        // A merchant-initiated refund is recorded as customer-requested — the
        // other Stripe reasons (duplicate/fraudulent) describe the original
        // charge, not an admin issuing a goodwill/return refund. Full refund:
        // `amount` is omitted.
        reason: "requested_by_customer",
        // The refund webhook reads these to resolve tenant + order, mirroring the
        // PaymentIntent metadata that drives PENDING → PAID.
        metadata: { tenantId, orderId },
      },
      // Same key across a network retry or a double-submit in the window before
      // the refund webhook flips the order → at most one refund is ever created
      // (mirrors the `idempotencyKey` on the checkout PaymentIntent). One full
      // refund per order, so the order id is the natural key.
      { idempotencyKey: `refund_${orderId}` },
    );
  },

  /**
   * Apply a refund to an order from a verified Stripe `refund.*` webhook: move it
   * PAID|FULFILLED → REFUNDED via the repository's atomic guarded transition.
   * This — not the admin initiation — is the source of truth for "refunded".
   * Idempotency lives in the repository's status guard, so a duplicate / late /
   * racing `refund.succeeded` (or an unknown PaymentIntent) is a safe no-op. The
   * outcome is reported three ways (see `MarkOrderRefundedResult`) so the webhook
   * can log each distinctly.
   */
  async markOrderRefunded(
    tenantId: string,
    paymentIntentId: string,
  ): Promise<MarkOrderRefundedResult> {
    const result = await orderRepository.markRefundedByPaymentIntent(
      tenantId,
      paymentIntentId,
    );
    if (result.transitioned) return { outcome: "refunded" };
    // Nothing moved — the repository already told us which case: an unknown
    // intent (currentStatus null) or an order that wasn't PAID/FULFILLED.
    if (result.currentStatus === null) return { outcome: "no-order" };
    return {
      outcome: "already-processed",
      currentStatus: result.currentStatus,
    };
  },

  /**
   * Sweep abandoned checkouts (#25) — the cron entry point
   * (`/api/cron/sweep-orders`). Finds `PENDING` orders older than the grace window
   * (across all tenants, like the outbox drain) and, for each still-uncharged one,
   * cancels its PaymentIntent and moves the order PENDING → CANCELLED, releasing
   * the inventory hold — so the DB and the Stripe dashboard don't accumulate orphan
   * checkouts. Reconciliation-based and idempotent: the guarded transition means a
   * missed, duplicated, or webhook-racing run is a safe no-op, and an order is
   * cancelled only once its intent is provably `canceled` (never one being paid).
   * Batch- and time-bounded; whatever isn't reached this run is swept by the next.
   * Per-run counts are returned for the route to log.
   */
  async sweepAbandonedPending(): Promise<SweepResult> {
    const olderThan = new Date(Date.now() - PENDING_SWEEP_AFTER_MS);
    const stale = await orderRepository.findStalePending(
      olderThan,
      SWEEP_BATCH_SIZE,
    );

    const result: SweepResult = { swept: 0, skipped: 0, errored: 0 };
    const deadline = Date.now() + SWEEP_TIME_BUDGET_MS;
    for (const order of stale) {
      // Stop starting new work once the budget is spent — better to leave the rest
      // for the next run than be force-killed mid-cancel at the route's maxDuration.
      if (Date.now() >= deadline) {
        const handled = result.swept + result.skipped + result.errored;
        sweepLog.info(
          { ...result, remaining: stale.length - handled },
          "sweep: time budget reached — remaining orders deferred to next run",
        );
        break;
      }
      try {
        result[await sweepOne(order)] += 1;
      } catch (err) {
        // Unexpected (a Stripe/DB error not already handled inside sweepOne). Leave
        // the order as-is — still PENDING — for the next run to reconcile.
        result.errored += 1;
        sweepLog.error(
          { err, orderId: order.id, tenantId: order.tenantId },
          "sweep: unexpected error; leaving order for a later run",
        );
      }
    }
    return result;
  },
};
