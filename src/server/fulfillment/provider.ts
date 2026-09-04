export interface FulfillmentLineItem {
  sku: string;
  quantity: number;
  /**
   * The snapshot **per-unit** price in integer cents (`OrderItem.priceCents`,
   * captured at checkout — never a float, golden rule #3). Threaded through the
   * seam so an adapter can print OUR retail price on the customer-facing packing
   * slip (Printful's optional per-item `retail_price`) instead of the provider's
   * own base price (M4 #148). It stays cents on this interface — the adapter is
   * the only place it becomes a decimal string, and only at the outbound HTTP
   * boundary. Per-unit, not the line total: `quantity` is carried separately.
   */
  priceCents: number;
  /**
   * The provider's opaque catalog variant id (e.g. Printful's integer
   * `variant_id`), resolved from our free-form `sku` by the submission service
   * via `ProductVariant.providerVariantId`. Optional on the interface so a
   * hypothetical provider keyed directly off `sku` needn't require it, and so the
   * seam stays swappable per this file's doc comment; the mock and Printful
   * adapters use it as the line's variant reference. A small, deliberate additive
   * amendment (M4 #137) — the sku→provider mapping gap is real, so the service
   * closes it here rather than blurring the adapter into a data-access layer.
   */
  providerVariantId?: string;
}

export interface ShippingAddress {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
}

export interface CreateFulfillmentInput {
  orderId: string;
  items: FulfillmentLineItem[];
  shippingAddress: ShippingAddress;
  /**
   * The order's currency (`Order.currency`; lowercase ISO 4217, Stripe's
   * convention). Order-level, never per-line — a cart/order is single-currency by
   * construction (currency lives on `Tenant`, not the variant), so every line
   * shares it. An adapter uses it to tell the provider which currency the per-item
   * retail prices (`FulfillmentLineItem.priceCents`) are in, so a tenant whose
   * currency differs from the provider account's default frames the packing slip in
   * the ORDER's currency instead of that default (M4 #157) — otherwise Printful
   * reads a bare `retail_price` in its single store's currency and mis-frames the
   * slip. Stays the raw domain code on the seam: the adapter is the only place it
   * becomes the provider's expected form (Printful's uppercase
   * `retail_costs.currency`), and only at the outbound HTTP boundary — the currency
   * twin of `priceCents`'s cents→decimal crossing.
   */
  currency: string;
}

export interface FulfillmentResult {
  externalId: string;
  status: "submitted" | "failed";
}

export interface TrackingInfo {
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  status: string;
  /**
   * Provider-computed TERMINAL-failure signal (M4 #151): `true` when the provider
   * reports this order was cancelled/failed *after* submission and will never ship,
   * so the poll cron can move it to a terminal `FulfillmentStatus.FAILED` instead of
   * re-polling it forever. Kept provider-agnostic exactly like
   * `FulfillmentResult.status`: each adapter maps its own raw vocabulary (Printful
   * `canceled`/`failed`) onto this closed signal, so the service never reads a raw
   * `status` string for control flow. Absent/`false` means the order is still in
   * flight (leave it SUBMITTED, re-poll) unless a `trackingNumber` marks it shipped —
   * a shipment always wins, so a provider never needs to set both.
   */
  terminalFailure?: boolean;
}

/**
 * Abstraction over dropshipping / print-on-demand suppliers. The rest of the
 * app depends only on this interface — swap Printful for Printify, a real
 * supplier, or a mock without touching order or checkout code.
 */
export interface FulfillmentProvider {
  readonly name: string;
  createOrder(input: CreateFulfillmentInput): Promise<FulfillmentResult>;
  getTracking(externalId: string): Promise<TrackingInfo>;
}
