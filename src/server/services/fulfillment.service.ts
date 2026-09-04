import "server-only";
import { getFulfillmentProvider } from "@/server/fulfillment";
import {
  orderRepository,
  type OrderForFulfillment,
} from "@/server/repositories/order.repository";
import type {
  CreateFulfillmentInput,
  FulfillmentLineItem,
  ShippingAddress,
} from "@/server/fulfillment/provider";
import { OrderNotFoundError } from "@/server/order.errors";
import {
  FulfillmentAddressMissingError,
  FulfillmentError,
  FulfillmentNotConfiguredError,
  FulfillmentNotMappedError,
  FulfillmentRejectedError,
} from "@/server/fulfillment.errors";

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
};

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
