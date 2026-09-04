import "server-only";
import {
  getFulfillmentProvider,
  type FulfillmentProvider,
} from "@/server/fulfillment";
import {
  orderRepository,
  type OrderForFulfillment,
  type SubmittedOrderForPolling,
} from "@/server/repositories/order.repository";
import type {
  CreateFulfillmentInput,
  FulfillmentLineItem,
  ShippingAddress,
  TrackingInfo,
} from "@/server/fulfillment/provider";
import { OrderNotFoundError } from "@/server/order.errors";
import {
  FulfillmentAddressMissingError,
  FulfillmentError,
  FulfillmentNotConfiguredError,
  FulfillmentNotMappedError,
  FulfillmentRejectedError,
} from "@/server/fulfillment.errors";
import { logger } from "@/server/observability/logger";

// --- Poll-fulfillment tuning (M4 #140) ---------------------------------------
// Module-local knobs, mirroring order.service's sweep constants.

/** Upper bound on open shipments pulled per poll run. The real stop condition is
 *  the time budget below (each order makes one provider `getTracking` call, run
 *  sequentially); this just caps the query so one run can't pull an unbounded set
 *  into memory. Whatever isn't reached drains over later runs — the poll is
 *  reconciliation-based, so a partial run is always safe. */
const POLL_BATCH_SIZE = 100;

/** Soft per-run wall-clock budget. The poll stops starting new orders once this
 *  elapses, so a slow provider (or a big backlog) degrades into "continues next
 *  run" rather than being force-killed at the route's `maxDuration` (60s) mid-poll.
 *  Kept comfortably under `maxDuration` (mirrors the sweep/drain budgets). */
const POLL_TIME_BUDGET_MS = 45_000;

/** How long an order may sit SUBMITTED before the poll surfaces it as a STUCK open
 *  shipment for a human to chase (M4 #155). Age is measured from `Order.createdAt` —
 *  the poll's oldest-first batch key (`findSubmittedForPolling`) and an immutable
 *  anchor. It precedes actual submission only by the PENDING→PAID + outbox-drain lag
 *  (minutes — a lingering PENDING order is cancelled by the abandoned-order sweep long
 *  before then), negligible against a multi-day threshold; and because it's *earlier*
 *  than submission the check can only ever fire slightly early, never miss a genuinely
 *  stuck order. (`updatedAt` would also serve — a not-shipped poll writes nothing, so it
 *  stays frozen at submission, and the only writers of the raw provider status are the
 *  terminal `markShipped`/`markFulfillmentFailedAfterSubmission` that leave the work list
 *  — but `createdAt` is already the ordering key and needs no reasoning about write
 *  patterns.) Set well beyond a normal produce-and-ship window: Printful assigns a
 *  tracking number at carrier handoff after production, up to ~a week, so 10 days leaves
 *  a clear buffer and a normally-progressing order (SHIPPED and gone from the SUBMITTED
 *  work list long before this) is never flagged — a provider hold (`onhold`/`inreview`)
 *  that never resolves is what trips it. Alert-only: a flagged order is NOT removed from
 *  polling (it may still ship); a human contacts the provider / refunds / re-orders.
 *  Module-local like the other poll knobs above. */
const STUCK_SUBMITTED_THRESHOLD_MS = 10 * 24 * 60 * 60_000; // 10 days

const pollLog = logger.child({ component: "fulfillment-poll" });

/** A tenant-scoped order reference the poll hands back for the route's immediate
 *  best-effort shipping-email dispatch (the #139 webhook pattern). */
export type ShippedOrderRef = { tenantId: string; orderId: string };

/** Per-run tallies from the poll-fulfillment cron (M4 #140), surfaced by the
 *  route for observability, plus the orders reconciled this run so the route can
 *  fire an immediate best-effort shipping-email dispatch (#141). */
export type PollResult = {
  /** Orders reconciled SUBMITTED → SHIPPED (Order PAID → FULFILLED) this run. */
  shipped: number;
  /** Orders the provider reported terminally failed (cancelled/failed AFTER
   *  submission): reconciled SUBMITTED → FAILED (M4 #151), so they leave the poll's
   *  work list instead of being re-polled forever and surface to the operator. The
   *  order stays PAID (a refund/re-order is a human decision). */
  failed: number;
  /** Orders surfaced this run as a STUCK open shipment (M4 #155): SUBMITTED +
   *  un-shipped past the age threshold — a provider hold (`onhold`/`inreview`) that
   *  isn't resolving. Alerted ONCE (idempotent via `Order.fulfillmentStuckAt`) and,
   *  unlike `failed`, left SUBMITTED — it may still ship, so it keeps being polled.
   *  Counts only the first run that surfaces each order; later runs count it `pending`. */
  stuck: number;
  /** Polled, but not reconciled this run for a benign reason — the provider hasn't
   *  shipped yet, or the order was concurrently refunded/fulfilled — left SUBMITTED. */
  pending: number;
  /** Poll hit a transient provider/DB fault (isolated so one can't abort the
   *  batch); the order is left SUBMITTED and retried next run. */
  errored: number;
  /** The orders reconciled to SHIPPED this run — the route dispatches each one's
   *  shipping email immediately (the outbox drain being the durable path).
   *  Consumed by the route; deliberately NOT echoed in its JSON response body. */
  shippedOrders: ShippedOrderRef[];
};

/** Outcome of polling one open shipment (drives the `PollResult` tally). `"stuck"`
 *  is a specialisation of `"pending"` — the order is still in flight and stays
 *  SUBMITTED, but this run was the one that first surfaced it as stuck (#155). */
type PollOutcome = "shipped" | "failed" | "pending" | "errored" | "stuck";

/**
 * Fulfillment orchestration — everything ABOVE the provider boundary (M4 #137),
 * now wired through the transactional outbox (M4 #139). It reads a tenant's order
 * and line items (with each variant's provider mapping), resolves
 * `sku → providerVariantId`, builds the provider-agnostic `CreateFulfillmentInput`
 * (address flattened off the order), submits it to the active
 * `FulfillmentProvider`, and OWNS the order's fulfillment-state persistence. All
 * data access lives here, so the provider adapter stays a pure HTTP client — the
 * "swap the supplier without touching order/checkout code" seam `provider.ts`
 * promises.
 *
 * Idempotency is two layers, because a duplicate POD order is real money + a
 * physical shipment and Printful has no idempotency key: the outbox message's own
 * atomic claim (one worker sends a given message at a time), plus an order-level
 * NOT_SUBMITTED → SUBMITTING claim here — only the winner calls the provider. Once
 * that claim is taken the order can never be safely re-submitted, so ANY non-clean
 * outcome fails toward "stuck in SUBMITTING, a human reconciles" rather than a
 * silent retry (see `runSubmission`).
 */
export const fulfillmentService = {
  /**
   * Submit a tenant's order to the fulfillment provider, idempotently. Delegates
   * the work to `runSubmission` and, on any *permanent* fulfillment failure,
   * records the order as `FulfillmentStatus.FAILED` before rethrowing — so the
   * outbox drain settles the message DEAD (never retries) and the admin sees a
   * terminal, actionable state. A *transient* provider fault (a plain `Error` the
   * adapter throws for a 5xx/timeout) is not a `FulfillmentError`, so it is NOT
   * recorded FAILED and propagates untouched for the outbox to retry with backoff.
   *
   * Returns nothing: the outcome is persisted on the order (SUBMITTED with the
   * provider id, or FAILED), which is the source of truth the poll cron and admin
   * read — the outbox only needs "threw or didn't".
   *
   * @throws FulfillmentNotConfiguredError  no provider is configured (prod, no key)
   * @throws FulfillmentNotMappedError      one or more variants are unmapped
   * @throws FulfillmentAddressMissingError the order carries no shipping address
   * @throws FulfillmentRejectedError       the provider soft-rejected the order
   * @throws OrderNotFoundError             no such order for the tenant
   */
  async submitOrder(tenantId: string, orderId: string): Promise<void> {
    try {
      await runSubmission(tenantId, orderId);
    } catch (err) {
      // Every typed `FulfillmentError` is permanent (unconfigured, unmapped,
      // missing address, or a provider soft-rejection): record it on the order as
      // FAILED — the terminal state the admin acts on — before rethrowing so the
      // outbox settles the message DEAD. A transient fault (a plain `Error`) is not
      // a `FulfillmentError`, so it is left unrecorded and propagates for retry; if
      // it was thrown AFTER the SUBMITTING claim, the order stays stuck in
      // SUBMITTING for manual reconciliation (never auto-resubmitted).
      if (err instanceof FulfillmentError) {
        await orderRepository.markFulfillmentFailed(tenantId, orderId);
      }
      throw err;
    }
  },

  /**
   * Poll the provider for every open shipment and reconcile the shipped ones — the
   * cron entry point (`/api/cron/poll-fulfillment`, M4 #140). Finds SUBMITTED (and
   * still PAID) orders across all tenants (like the sweep/drain), asks the provider
   * for each one's tracking, and for those the provider reports shipped flips the
   * order PAID → FULFILLED with tracking persisted and the shipping email enqueued —
   * all in one guarded, idempotent transaction (`orderRepository.markShipped`).
   *
   * Reconciliation-based and idempotent: a missed, duplicated, or racing run is a
   * safe no-op — an unshipped order is simply re-checked next run, an
   * already-reconciled one has left SUBMITTED so it is never re-polled, and the
   * guarded flip enqueues the email exactly once. Batch- and time-bounded; whatever
   * isn't reached this run is polled by the next. When no provider is configured
   * (production without `PRINTFUL_API_KEY`) there is nothing to reconcile — warn and
   * return zeros. Per-run counts are returned for the route to log, alongside the
   * orders reconciled this run so the route can dispatch their shipping emails
   * immediately (#141) rather than wait for the next cron tick's outbox drain.
   */
  async pollOpenShipments(): Promise<PollResult> {
    const provider = getFulfillmentProvider();
    if (!provider) {
      // Nothing could have been submitted, so nothing can be reconciled — the
      // FulfillmentNotConfigured posture (warn, don't error).
      pollLog.warn(
        "poll: no fulfillment provider configured — nothing to reconcile",
      );
      return {
        shipped: 0,
        failed: 0,
        stuck: 0,
        pending: 0,
        errored: 0,
        shippedOrders: [],
      };
    }

    const open = await orderRepository.findSubmittedForPolling(POLL_BATCH_SIZE);

    const result: PollResult = {
      shipped: 0,
      failed: 0,
      stuck: 0,
      pending: 0,
      errored: 0,
      shippedOrders: [],
    };
    const deadline = Date.now() + POLL_TIME_BUDGET_MS;
    for (const order of open) {
      // Stop starting new work once the budget is spent — better to leave the rest
      // for the next run than be force-killed mid-poll at the route's maxDuration.
      if (Date.now() >= deadline) {
        const handled =
          result.shipped +
          result.failed +
          result.stuck +
          result.pending +
          result.errored;
        pollLog.info(
          { ...result, remaining: open.length - handled },
          "poll: time budget reached — remaining orders deferred to next run",
        );
        break;
      }
      try {
        const outcome = await pollOne(provider, order);
        result[outcome] += 1;
        // Collect the just-shipped order so the route can fire its immediate
        // best-effort shipping-email dispatch (the daily drain is the durable path).
        if (outcome === "shipped") {
          result.shippedOrders.push({
            tenantId: order.tenantId,
            orderId: order.id,
          });
        }
      } catch (err) {
        // Unexpected (a DB error in markShipped not already handled inside pollOne).
        // Leave the order SUBMITTED — still reconcilable — for the next run.
        result.errored += 1;
        pollLog.error(
          { err, orderId: order.id, tenantId: order.tenantId },
          "poll: unexpected error; leaving order for a later run",
        );
      }
    }
    return result;
  },
};

/**
 * Poll and reconcile ONE open shipment (M4 #140, terminal-fail exit #151). Asks the
 * provider for the order's tracking, and:
 *  - a transient `getTracking` fault (the adapter throws a plain Error for a
 *    404/401/5xx/timeout) → `"errored"`: leave the order SUBMITTED, retry next run;
 *  - a tracking number present → the shipped signal: persist tracking + flip
 *    PAID → FULFILLED + enqueue the shipping email via the guarded, atomic
 *    `markShipped`. `"shipped"` if it made the transition, `"pending"` if the order
 *    left PAID+SUBMITTED first (a refund/manual-fulfil race — benign no-op);
 *  - no tracking number BUT the provider flags a terminal failure → `"failed"`:
 *    reconcile SUBMITTED → FAILED via `markFulfillmentFailedAfterSubmission` so the
 *    order (which will never ship) leaves the work list and surfaces to the operator;
 *    `"pending"` if that guarded write matched nothing (the same benign race);
 *  - no tracking number and not flagged → `"pending"`: still in flight, write nothing
 *    (a not-shipped poll is a pure no-op) and re-check next run.
 *
 * "Shipped" is signalled provider-agnostically by the presence of a tracking NUMBER,
 * not the raw status string: the mock emits one only once shipped, and Printful
 * populates `shipments[].tracking_number` when the order ships. The raw status is
 * admin-display only — persisted as `fulfillmentProviderStatus`, never itself a
 * control-flow input — so we never flip FULFILLED on a "shipped"/"fulfilled" status
 * that carries no parcel to put in the email. The one non-tracking control signal is
 * `TrackingInfo.terminalFailure`, and it too is provider-agnostic: each adapter
 * derives it from its own raw vocabulary (the poll-side analogue of a create-time
 * soft rejection), so the service still never branches on a raw status string. A DB
 * error from either guarded write propagates to the caller's per-order isolation.
 */
async function pollOne(
  provider: FulfillmentProvider,
  order: SubmittedOrderForPolling,
): Promise<PollOutcome> {
  const { id, tenantId, fulfillmentExternalId } = order;

  // A SUBMITTED order always carries the provider's real order id (`markSubmitted`
  // is its only writer, on the success path). A null here is a data anomaly we
  // can't reconcile — surface it and skip, never call getTracking with an empty id.
  if (!fulfillmentExternalId) {
    pollLog.error(
      { orderId: id, tenantId },
      "poll: SUBMITTED order has no fulfillmentExternalId — cannot reconcile",
    );
    return "errored";
  }

  let tracking: TrackingInfo;
  try {
    tracking = await provider.getTracking(fulfillmentExternalId);
  } catch (err) {
    // Transient provider fault — leave the order SUBMITTED; the next run retries.
    pollLog.warn(
      { err, orderId: id, tenantId, externalId: fulfillmentExternalId },
      "poll: getTracking failed — leaving order for a later run",
    );
    return "errored";
  }

  // No shipment yet (a tracking NUMBER always wins — checked below — so a shipped
  // order is never diverted here). Before treating it as still in flight, check for a
  // provider TERMINAL failure: the provider cancelled/failed the order AFTER we
  // submitted it, so it will never ship (M4 #151). Left as-is it would sit
  // SUBMITTED + PAID forever and be re-polled every run — starving newer orders
  // (oldest-first batching) and burning provider rate limit — so reconcile it to a
  // terminal FAILED, which drops it from the work list and surfaces it to the
  // operator. `terminalFailure` is the provider-computed, provider-agnostic signal
  // (the poll-side analogue of a create-time soft rejection); the raw status string
  // stays admin-display only, never itself a control-flow input.
  if (!tracking.trackingNumber) {
    if (tracking.terminalFailure) {
      const failed = await orderRepository.markFulfillmentFailedAfterSubmission(
        tenantId,
        id,
        tracking.status,
      );
      // A `false` return mirrors markShipped: the order left PAID+SUBMITTED first (a
      // refund or manual fulfil raced us), so this call didn't fail it — a benign
      // no-op counted as pending, not a terminal failure we caused this run.
      if (!failed) {
        pollLog.info(
          { orderId: id, tenantId },
          "poll: order left PAID/SUBMITTED before terminal-fail reconcile (refunded or manually fulfilled) — skipping",
        );
        return "pending";
      }
      // A provider cancellation of a PAID order is money captured with no product
      // coming — the fulfillment-side twin of the oversell / refund-failed alerts on
      // the Stripe webhook. Surface it loudly at ERROR (not warn): those money-at-risk,
      // operator-must-act events are logged at `error` there for exactly this reason —
      // it's the only severity signal (nothing routes through `reportError`), and a
      // `warn` line ages out of Vercel Hobby's 1-hour retention before an operator
      // sees it. Include the raw provider status for context.
      pollLog.error(
        {
          orderId: id,
          tenantId,
          externalId: fulfillmentExternalId,
          providerStatus: tracking.status,
        },
        "poll: provider reports order terminally failed — moved to FAILED, needs manual refund/re-order",
      );
      return "failed";
    }
    // Genuinely in flight — nothing to reconcile (a not-shipped poll writes nothing
    // to the order's lifecycle) and re-checked next run. But if it has been in flight
    // too long — SUBMITTED since `createdAt`, past the stuck threshold — surface it
    // ONCE so an operator can chase a provider hold (`onhold`/`inreview`) that isn't
    // resolving. Unlike the terminal-fail exit above we leave `fulfillmentStatus`
    // SUBMITTED (an onhold order can still ship) and keep polling it.
    return await flagIfStuck(order, tracking.status);
  }

  // Shipped: reconcile atomically + idempotently. A `false` return means the order
  // left PAID+SUBMITTED before we got here (a refund or manual fulfil raced us), so
  // we simply didn't ship it — a benign no-op, not a shipment.
  const shipped = await orderRepository.markShipped(tenantId, id, {
    providerStatus: tracking.status,
    carrier: tracking.carrier ?? null,
    trackingNumber: tracking.trackingNumber,
    trackingUrl: tracking.trackingUrl ?? null,
  });
  if (!shipped) {
    pollLog.info(
      { orderId: id, tenantId },
      "poll: order left PAID/SUBMITTED before reconcile (refunded or manually fulfilled) — skipping",
    );
    return "pending";
  }

  pollLog.info(
    { orderId: id, tenantId, externalId: fulfillmentExternalId },
    "poll: order shipped — reconciled to FULFILLED with tracking",
  );
  return "shipped";
}

/**
 * The in-flight tail of `pollOne` (M4 #155): decide whether an order still SUBMITTED
 * (no shipment, not a terminal failure) has been open too long and, if so, surface it
 * ONCE. "Too long" is `Date.now() - createdAt` past `STUCK_SUBMITTED_THRESHOLD_MS` —
 * a provider hold (`onhold`/`inreview`) that isn't resolving. Idempotency is durable,
 * not per-process: `markFulfillmentStuck` stamps `Order.fulfillmentStuckAt` under a
 * `fulfillmentStuckAt: null` guard, so only the first run across all cron ticks wins,
 * and the pre-read `fulfillmentStuckAt` short-circuits the already-surfaced case
 * without even attempting the write.
 *
 * Returns `"stuck"` only on the run that first surfaces the order (stamped + alerted),
 * `"pending"` otherwise — under the threshold, already surfaced, or the guarded write
 * lost a benign PAID/SUBMITTED race (refunded / manually fulfilled underneath us). The
 * order is left SUBMITTED and keeps being polled in every case: #155 alerts, it does
 * not stop reconciliation, because an onhold order can still ship.
 */
async function flagIfStuck(
  order: SubmittedOrderForPolling,
  providerStatus: string,
): Promise<PollOutcome> {
  const { id, tenantId, createdAt, fulfillmentStuckAt, fulfillmentExternalId } =
    order;

  // Still within the window, or already surfaced in an earlier run — nothing to do.
  const age = Date.now() - createdAt.getTime();
  if (age < STUCK_SUBMITTED_THRESHOLD_MS || fulfillmentStuckAt !== null) {
    return "pending";
  }

  const flagged = await orderRepository.markFulfillmentStuck(tenantId, id);
  if (!flagged) {
    // Lost the guard: another run stamped it first, or the order left PAID/SUBMITTED
    // (refunded / manually fulfilled) between the select and here — a benign no-op,
    // counted as pending, no alert. Mirrors the terminal-fail / markShipped race path.
    pollLog.info(
      { orderId: id, tenantId },
      "poll: order left PAID/SUBMITTED before stuck-flag (refunded, manually fulfilled, or flagged by a racing run) — skipping",
    );
    return "pending";
  }

  // Money captured, no product shipping yet, and the provider isn't resolving it: the
  // fulfillment-side twin of the #151 terminal-fail and the oversell / refund-failed
  // alerts. ERROR (not warn) for the same reason as those — it's the only severity
  // signal (nothing routes through `reportError`), and a `warn` ages out of Vercel
  // Hobby's 1-hour retention before an operator sees it. `fulfillmentStatus` is left
  // SUBMITTED on purpose (the order may still ship); the raw provider status + age are
  // carried for context so the operator knows which hold to chase.
  pollLog.error(
    {
      orderId: id,
      tenantId,
      externalId: fulfillmentExternalId,
      providerStatus,
      ageHours: Math.floor(age / 3_600_000),
    },
    "poll: order stuck SUBMITTED past the age threshold (provider hold not resolving) — left SUBMITTED, needs manual review (contact provider / refund / re-order)",
  );
  return "stuck";
}

/**
 * The submission itself, minus the FAILED bookkeeping its caller wraps around it.
 * Validates all-or-nothing up front (an unmapped variant or missing address throws
 * before any provider call — never a half-submitted order), then:
 *
 *  1. claims the order NOT_SUBMITTED → SUBMITTING (the layer-2 idempotency guard).
 *     If the claim is lost — a concurrent drain, a re-drain after a lost worker, or
 *     an already-terminal / stuck order — it returns WITHOUT calling the provider,
 *     so the order is never double-submitted;
 *  2. calls `provider.createOrder`. From here on the order can never be safely
 *     re-submitted (the claim blocks it), so a soft `"failed"` result is recorded
 *     FAILED and rethrown as `FulfillmentRejectedError`, and a transient throw is
 *     left to strand the order in SUBMITTING for a human — neither re-submits;
 *  3. on success, persists SUBMITTING → SUBMITTED with the provider's order id +
 *     name for the poll cron to reconcile against.
 */
async function runSubmission(tenantId: string, orderId: string): Promise<void> {
  // Fail fast if fulfillment isn't configured — no point reading the order we
  // could never submit anywhere.
  const provider = getFulfillmentProvider();
  if (!provider) {
    throw new FulfillmentNotConfiguredError();
  }

  const order = await orderRepository.findForFulfillment(tenantId, orderId);
  if (!order) {
    throw new OrderNotFoundError();
  }

  // Resolve the mapping first: an unmapped variant is the expected, admin-fixable
  // failure this milestone is designed around, so report it ahead of the
  // should-never-happen missing-address anomaly. Both throw before the claim, so a
  // permanent validation failure leaves the order NOT_SUBMITTED → FAILED.
  const input: CreateFulfillmentInput = {
    orderId: order.id,
    items: toLineItems(order),
    shippingAddress: toShippingAddress(order),
  };

  // Layer-2 idempotency guard: only the caller that flips NOT_SUBMITTED → SUBMITTING
  // proceeds to the provider. A lost claim means someone else owns it, it already
  // reached a terminal state, or it is stuck SUBMITTING from a lost worker — in
  // every case we must NOT submit again.
  const claimed = await orderRepository.claimForSubmission(tenantId, orderId);
  if (!claimed) {
    return;
  }

  const result = await provider.createOrder(input);
  if (result.status === "failed") {
    // A soft rejection of THIS order (a bad variant/address the provider won't
    // accept) — not a transient outage. Record FAILED (the wrapper does, catching
    // this) and surface it as a permanent error; never persist the provider's
    // placeholder id (it must not reach getTracking).
    throw new FulfillmentRejectedError(order.id, provider.name);
  }

  // Provider accepted it: persist the external id + provider and move
  // SUBMITTING → SUBMITTED, so the poll cron can reconcile tracking against them.
  await orderRepository.markSubmitted(
    tenantId,
    orderId,
    result.externalId,
    provider.name,
  );
}

/**
 * Resolve every line's `sku → providerVariantId` off the eager-loaded variant and
 * carry its snapshot unit price, failing all-or-nothing: an unmapped variant is a
 * defined, admin-visible failure (map it in the product form), not a silent
 * provider 4xx or a partial shipment. The per-unit `priceCents` (M4 #148) is read
 * off the `OrderItem` — the purchase-time snapshot, not the live variant/catalog
 * price — so the adapter can print our retail price on the provider's packing slip.
 */
function toLineItems(order: OrderForFulfillment): FulfillmentLineItem[] {
  const unmapped: string[] = [];
  const items = order.items.map((item): FulfillmentLineItem => {
    const { sku, providerVariantId } = item.variant;
    if (!providerVariantId) {
      unmapped.push(sku);
    }
    return {
      sku,
      quantity: item.quantity,
      // The snapshot per-unit price (cents) rides on the line so the adapter can
      // put OUR price on the provider's packing slip (#148). It lives on the
      // OrderItem (a purchase-time snapshot), never re-derived from the variant.
      priceCents: item.priceCents,
      providerVariantId: providerVariantId ?? undefined,
    };
  });
  if (unmapped.length > 0) {
    throw new FulfillmentNotMappedError(unmapped);
  }
  return items;
}

/**
 * Flatten the order's nullable `ship*` columns into the provider's required
 * `ShippingAddress`, narrowing the nullable fields. A paid order should always
 * carry one (#135 collects it; #139 only enqueues submission when it's present),
 * so a missing required field is a defined, permanent failure rather than a blank
 * address sent to the provider — never an unsafe non-null assertion.
 */
function toShippingAddress(order: OrderForFulfillment): ShippingAddress {
  const {
    id,
    shipName,
    shipLine1,
    shipLine2,
    shipCity,
    shipState,
    shipPostalCode,
    shipCountry,
  } = order;
  if (!shipName || !shipLine1 || !shipCity || !shipPostalCode || !shipCountry) {
    throw new FulfillmentAddressMissingError(id);
  }
  return {
    name: shipName,
    line1: shipLine1,
    line2: shipLine2 ?? undefined,
    city: shipCity,
    state: shipState ?? undefined,
    postalCode: shipPostalCode,
    country: shipCountry,
  };
}
