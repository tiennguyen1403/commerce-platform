export interface FulfillmentLineItem {
  sku: string;
  quantity: number;
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
