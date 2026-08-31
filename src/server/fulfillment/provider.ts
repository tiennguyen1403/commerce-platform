export interface FulfillmentLineItem {
  sku: string;
  quantity: number;
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
