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
 * order for this tenant+email whose currency, total, and line-set match the
 * freshly-repriced cart, then confirms the linked PaymentIntent is still awaiting
 * payment (and its amount/currency still match) before handing back its existing
 * client secret. Returns null — meaning "create a fresh intent" — on any miss: no
 * candidate, a line-set mismatch, an unreadable or non-reusable intent, or a
 * drifted amount. Price stays the security boundary: the match is against the
 * re-priced cart (`cart.totalCents`), never a stored total.
 */
async function tryReuseInFlightIntent(
  tenantId: string,
  email: string,
  cart: CartView,
): Promise<StartCheckoutResult | null> {
  const candidates = await orderRepository.findReusablePendingCandidates({
    tenantId,
    email,
    totalCents: cart.totalCents,
    currency: cart.currency,
    createdAfter: new Date(Date.now() - PENDING_REUSE_WINDOW_MS),
    limit: REUSE_CANDIDATE_LIMIT,
  });

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

  let paymentIntent: Stripe.PaymentIntent;
  try {
    paymentIntent = await getStripe().paymentIntents.retrieve(
      order.stripePaymentIntentId,
    );
  } catch (err) {
    // Can't read the intent (unknown/deleted, or Stripe is down) — we can't prove
    // it's uncharged, so leave the order for a later run rather than cancel blindly.
    sweepLog.warn(
      { err, orderId: order.id, paymentIntentId: order.stripePaymentIntentId },
      "sweep: could not retrieve PaymentIntent; leaving order for a later run",
    );
    return "skipped";
  }

  switch (paymentIntent.status) {
    // Payment captured or capturing — the webhook owns this order; never cancel.
    case "succeeded":
      // A *succeeded* intent whose order is still PENDING past the grace window
      // means the webhook is lagging or was lost — surface it loudly; the order is
      // real and must not be cancelled.
      sweepLog.error(
        {
          orderId: order.id,
          paymentIntentId: paymentIntent.id,
          tenantId: order.tenantId,
        },
        "sweep: PaymentIntent SUCCEEDED but order still PENDING — webhook may be lost; NOT cancelling",
      );
      return "skipped";
    case "processing":
    case "requires_capture":
      sweepLog.info(
        {
          orderId: order.id,
          paymentIntentId: paymentIntent.id,
          status: paymentIntent.status,
        },
        "sweep: payment in progress; leaving order for the webhook",
      );
      return "skipped";

    // The shopper started a payment that still needs authentication (3DS). In
    // flight — don't cancel. If they abandon it, Stripe returns the intent to
    // requires_payment_method and a later run sweeps it.
    case "requires_action":
      sweepLog.info(
        { orderId: order.id, paymentIntentId: paymentIntent.id },
        "sweep: payment awaiting customer action; leaving for a later run",
      );
      return "skipped";

    // Already canceled at Stripe (e.g. a prior run canceled the intent but didn't
    // finish the DB flip before dying) — reconcile the order now; no cancel needed.
    case "canceled":
      return flip();

    // requires_payment_method | requires_confirmation: an abandoned, still-chargeable
    // intent. Cancel it, and flip the order ONLY if the cancel confirms it's now
    // canceled — so a shopper who pays in the race window (cancel fails) keeps their
    // order PENDING for the webhook to complete.
    case "requires_payment_method":
    case "requires_confirmation": {
      const canceled = await cancelPaymentIntentReporting(paymentIntent.id);
      if (!canceled) {
        sweepLog.warn(
          {
            orderId: order.id,
            paymentIntentId: paymentIntent.id,
            status: paymentIntent.status,
          },
          "sweep: PaymentIntent cancel did not take (likely paid mid-sweep); leaving order for the webhook",
        );
        return "skipped";
      }
      return flip();
    }

    // An unknown/future status we don't understand — be conservative and never
    // cancel what we can't classify; surface it and leave the order for review.
    default:
      sweepLog.warn(
        {
          orderId: order.id,
          paymentIntentId: paymentIntent.id,
          status: paymentIntent.status,
        },
        "sweep: unexpected PaymentIntent status; leaving order untouched",
      );
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
  ): Promise<StartCheckoutResult> {
    const cart = await cartService.getCartView(tenantId, lines, currency);
    if (cart.items.length === 0) throw new EmptyCartError();

    // Dedupe: if this looks like a re-submit of a cart already in flight, reuse the
    // existing intent rather than minting a second PENDING order + chargeable
    // PaymentIntent (and a second inventory hold). A miss just falls through to a
    // fresh create; the sweep below is the safety net for anything left abandoned.
    const reused = await tryReuseInFlightIntent(tenantId, email, cart);
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
   * Cancel a PENDING order (admin action): release its inventory hold and move it
   * to CANCELLED. Delegates the atomic guarded transition to the repository and
   * translates a no-op into a typed error the action boundary maps to a message —
   * `OrderNotFoundError` (no such order) or `OrderTransitionError` (it exists but
   * isn't PENDING: already paid/cancelled/fulfilled).
   *
   * This is a STAFF+ operation. The role is enforced by the calling admin Server
   * Action with `assertRole(ROLES.STAFF)` before it calls in — services stay
   * role-agnostic and tenant-scoped, matching the codebase's boundary-gating
   * pattern (see membership.service). The admin orders UI that wires this action
   * lands with #40; this method is its tested backend.
   */
  async cancelOrder(tenantId: string, orderId: string): Promise<void> {
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
