import { describe, it, expect } from "vitest";
import {
  MockProvider,
  MOCK_FAILING_VARIANT_ID,
} from "@/server/fulfillment/mock";
import type {
  CreateFulfillmentInput,
  ShippingAddress,
} from "@/server/fulfillment/provider";

/**
 * The deterministic mock provider's own behaviour — the canned `createOrder`
 * results (including the sentinel-driven `"failed"` path) and the
 * `submitted → shipped` tracking progression. The service suite exercises the mock
 * end-to-end through `submitOrder`; this pins the mock's contract directly.
 */

const ADDRESS: ShippingAddress = {
  name: "Ada Lovelace",
  line1: "1 Analytical Ave",
  city: "San Francisco",
  state: "CA",
  postalCode: "94103",
  country: "US",
};

function input(
  o: Partial<CreateFulfillmentInput> = {},
): CreateFulfillmentInput {
  return {
    orderId: "order_1",
    items: [{ sku: "TEE-S", quantity: 2, providerVariantId: "4011" }],
    shippingAddress: ADDRESS,
    ...o,
  };
}

describe("MockProvider", () => {
  it("is named 'mock'", () => {
    expect(new MockProvider().name).toBe("mock");
  });

  describe("createOrder", () => {
    it("returns a canned submitted result, id derived from the order id", async () => {
      const provider = new MockProvider();
      expect(await provider.createOrder(input())).toEqual({
        externalId: "mock_order_1",
        status: "submitted",
      });
      expect(
        (await provider.createOrder(input({ orderId: "order_42" }))).externalId,
      ).toBe("mock_order_42");
    });

    it("fails when any line carries the failing sentinel", async () => {
      const provider = new MockProvider();
      const result = await provider.createOrder(
        input({
          items: [
            { sku: "TEE-S", quantity: 1, providerVariantId: "4011" },
            {
              sku: "BAD",
              quantity: 1,
              providerVariantId: MOCK_FAILING_VARIANT_ID,
            },
          ],
        }),
      );
      expect(result).toEqual({ externalId: "mock_order_1", status: "failed" });
    });
  });

  describe("getTracking", () => {
    it("progresses submitted → shipped across polls", async () => {
      const provider = new MockProvider();
      const { externalId } = await provider.createOrder(input());

      expect(await provider.getTracking(externalId)).toEqual({
        status: "submitted",
      });
      expect(await provider.getTracking(externalId)).toEqual({
        status: "shipped",
        carrier: "Mock Carrier",
        trackingNumber: `MOCK-${externalId}`,
        trackingUrl: `https://tracking.example.test/${externalId}`,
      });
    });

    it("stays shipped on subsequent polls", async () => {
      const provider = new MockProvider();
      const { externalId } = await provider.createOrder(input());
      await provider.getTracking(externalId); // submitted
      await provider.getTracking(externalId); // shipped
      expect((await provider.getTracking(externalId)).status).toBe("shipped");
    });
  });
});
