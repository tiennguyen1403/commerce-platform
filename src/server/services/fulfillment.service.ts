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

/** Outcome of polling one open shipment (drives the `PollResult` tally). */
type PollOutcome = "shipped" | "pending" | "errored";

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
      return { shipped: 0, pending: 0, errored: 0, shippedOrders: [] };
    }

    const open = await orderRepository.findSubmittedForPolling(POLL_BATCH_SIZE);

    const result: PollResult = {
      shipped: 0,
      pending: 0,
      errored: 0,
      shippedOrders: [],
    };
    const deadline = Date.now() + POLL_TIME_BUDGET_MS;
    for (const order of open) {
      // Stop starting new work once the budget is spent — better to leave the rest
      // for the next run than be force-killed mid-poll at the route's maxDuration.
      if (Date.now() >= deadline) {
        const handled = result.shipped + result.pending + result.errored;
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
 * Poll and reconcile ONE open shipment (M4 #140). Asks the provider for the order's
 * tracking, and:
 *  - a transient `getTracking` fault (the adapter throws a plain Error for a
 *    404/401/5xx/timeout) → `"errored"`: leave the order SUBMITTED, retry next run;
 *  - no tracking number yet → `"pending"`: the provider hasn't shipped it, so write
 *    nothing (a not-shipped poll is a pure no-op) and re-check next run;
 *  - a tracking number present → the shipped signal: persist tracking + flip
 *    PAID → FULFILLED + enqueue the shipping email via the guarded, atomic
 *    `markShipped`. `"shipped"` if it made the transition, `"pending"` if the order
 *    left PAID+SUBMITTED first (a refund/manual-fulfil race — benign no-op).
 *
 * "Shipped" is signalled provider-agnostically by the presence of a tracking NUMBER,
 * not the raw status string: the mock emits one only once shipped, and Printful
 * populates `shipments[].tracking_number` when the order ships. The raw status is
 * admin-display only — persisted as `fulfillmentProviderStatus` in the reconcile,
 * never a control-flow input — so we never flip FULFILLED on a "shipped"/"fulfilled"
 * status that carries no parcel to put in the email. A DB error from `markShipped`
 * is left to propagate to the caller's per-order isolation (unexpected).
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

  // Not shipped yet — nothing to persist. Re-checked next run.
  if (!tracking.trackingNumber) {
    return "pending";
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
 * Resolve every line's `sku → providerVariantId` off the eager-loaded variant,
 * failing all-or-nothing: an unmapped variant is a defined, admin-visible failure
 * (map it in the product form), not a silent provider 4xx or a partial shipment.
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
