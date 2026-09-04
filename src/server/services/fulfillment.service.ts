import "server-only";
import { getFulfillmentProvider } from "@/server/fulfillment";
import {
  orderRepository,
  type OrderForFulfillment,
} from "@/server/repositories/order.repository";
import type {
  CreateFulfillmentInput,
  FulfillmentLineItem,
  FulfillmentResult,
  ShippingAddress,
} from "@/server/fulfillment/provider";
import { OrderNotFoundError } from "@/server/order.errors";
import {
  FulfillmentAddressMissingError,
  FulfillmentNotConfiguredError,
  FulfillmentNotMappedError,
} from "@/server/fulfillment.errors";

/**
 * Fulfillment orchestration — everything ABOVE the provider boundary (M4 #137).
 * It reads a tenant's order and line items (with each variant's provider mapping),
 * resolves `sku → providerVariantId` via the repository, builds the
 * provider-agnostic `CreateFulfillmentInput` (address flattened off the order),
 * and hands it to the active `FulfillmentProvider`. All data access lives here, so
 * the provider adapter stays a pure HTTP client — the "swap the supplier without
 * touching order/checkout code" seam `provider.ts` promises.
 *
 * Deliberately a *skeleton*: it validates and submits, but owns no persistence or
 * idempotency guard yet. The order-level `SUBMITTING` claim, persisting
 * `fulfillmentExternalId`, and mapping a soft `"failed"` result onto
 * `FulfillmentStatus.FAILED` are layered on when submission is wired through the
 * transactional outbox (M4 #139). This issue's job is only to make the whole flow
 * buildable and testable against the mock before the real Printful adapter exists.
 */
export const fulfillmentService = {
  /**
   * Submit a tenant's order to the fulfillment provider. Resolves and validates
   * the entire order up front, so submission is all-or-nothing: if ANY line lacks
   * a provider mapping it throws `FulfillmentNotMappedError` — never a
   * half-submitted order. Returns the provider's `FulfillmentResult`, including a
   * soft `"failed"` (a variant/address the provider rejects), which is a resolved
   * value here rather than a throw; the outbox caller (#139) persists it.
   *
   * @throws FulfillmentNotConfiguredError  no provider is configured (prod, no key)
   * @throws OrderNotFoundError             no such order for the tenant
   * @throws FulfillmentNotMappedError      one or more variants are unmapped
   * @throws FulfillmentAddressMissingError the order carries no shipping address
   */
  async submitOrder(
    tenantId: string,
    orderId: string,
  ): Promise<FulfillmentResult> {
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
    // should-never-happen missing-address anomaly.
    const items = toLineItems(order);
    const shippingAddress = toShippingAddress(order);

    const input: CreateFulfillmentInput = {
      orderId: order.id,
      items,
      shippingAddress,
    };
    return provider.createOrder(input);
  },
};

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
