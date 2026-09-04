import { describe, it, expect, beforeEach, vi } from "vitest";
import { getFulfillmentProvider } from "@/server/fulfillment";
import {
  MockProvider,
  MOCK_FAILING_VARIANT_ID,
} from "@/server/fulfillment/mock";
import { fulfillmentService } from "@/server/services/fulfillment.service";
import {
  orderRepository,
  type OrderForFulfillment,
} from "@/server/repositories/order.repository";
import { OrderNotFoundError } from "@/server/order.errors";
import {
  FulfillmentAddressMissingError,
  FulfillmentNotConfiguredError,
  FulfillmentNotMappedError,
} from "@/server/fulfillment.errors";

/**
 * Unit tests for the fulfillment service, run entirely against the deterministic
 * mock provider. The provider selector is mocked at the same seam
 * `order.service.test.ts` mocks `getStripe` (a module-level factory the service
 * calls), and the order repository is mocked so no DB is touched. Under test is
 * what the SERVICE owns: the not-configured guard, the tenant-scoped read, the
 * all-or-nothing `sku → providerVariantId` resolution, the address narrowing, and
 * the exact `CreateFulfillmentInput` handed to the provider.
 */

vi.mock("@/server/fulfillment", () => ({ getFulfillmentProvider: vi.fn() }));
vi.mock("@/server/repositories/order.repository", () => ({
  orderRepository: { findForFulfillment: vi.fn() },
}));

const getProvider = vi.mocked(getFulfillmentProvider);
const findForFulfillment = vi.mocked(orderRepository.findForFulfillment);

const TENANT = "tenant_1";

type FulfillmentItem = OrderForFulfillment["items"][number];

function item(o: Partial<FulfillmentItem> = {}): FulfillmentItem {
  return {
    id: "item_1",
    orderId: "order_1",
    variantId: "v1",
    titleSnapshot: "Tee — Blue",
    priceCents: 1500,
    quantity: 2,
    variant: { sku: "TEE-S", providerVariantId: "4011" },
    ...o,
  };
}

// A fully-shippable order as `findForFulfillment` returns it: full US address +
// one mapped variant. Overrides flip one facet per test (unmapped line, no
// address, a failing variant).
function fulfillmentOrder(
  o: Partial<OrderForFulfillment> = {},
): OrderForFulfillment {
  return {
    id: "order_1",
    tenantId: TENANT,
    orderNumber: "20250101-AAA111",
    status: "PAID",
    email: "shopper@example.com",
    userId: null,
    totalCents: 3000,
    currency: "usd",
    stripePaymentIntentId: "pi_1",
    oversold: false,
    shipName: "Ada Lovelace",
    shipLine1: "1 Analytical Ave",
    shipLine2: "Apt 2",
    shipCity: "San Francisco",
    shipState: "CA",
    shipPostalCode: "94103",
    shipCountry: "US",
    fulfillmentProvider: null,
    fulfillmentExternalId: null,
    fulfillmentStatus: "NOT_SUBMITTED",
    fulfillmentProviderStatus: null,
    trackingCarrier: null,
    trackingNumber: null,
    trackingUrl: null,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    updatedAt: new Date("2025-01-01T00:00:00.000Z"),
    items: [item()],
    ...o,
  };
}

let provider: MockProvider;

beforeEach(() => {
  vi.resetAllMocks();
  provider = new MockProvider();
  // Spy but keep the real mock behaviour (spyOn calls through by default), so we
  // assert the exact input AND get a real submitted/failed result back.
  vi.spyOn(provider, "createOrder");
  getProvider.mockReturnValue(provider);
});

/** The spied `createOrder`, typed for `.mock`/`toHaveBeenCalled*` assertions. */
function createOrderMock() {
  return vi.mocked(provider.createOrder);
}

describe("fulfillmentService.submitOrder", () => {
  it("submits a mapped order with the built CreateFulfillmentInput", async () => {
    findForFulfillment.mockResolvedValue(fulfillmentOrder());

    const result = await fulfillmentService.submitOrder(TENANT, "order_1");

    expect(findForFulfillment).toHaveBeenCalledWith(TENANT, "order_1");
    expect(createOrderMock()).toHaveBeenCalledWith({
      orderId: "order_1",
      items: [{ sku: "TEE-S", quantity: 2, providerVariantId: "4011" }],
      shippingAddress: {
        name: "Ada Lovelace",
        line1: "1 Analytical Ave",
        line2: "Apt 2",
        city: "San Francisco",
        state: "CA",
        postalCode: "94103",
        country: "US",
      },
    });
    expect(result).toEqual({ externalId: "mock_order_1", status: "submitted" });
  });

  it("resolves each line's providerVariantId from its variant, not the snapshot", async () => {
    findForFulfillment.mockResolvedValue(
      fulfillmentOrder({
        items: [
          item({
            quantity: 3,
            variant: { sku: "HOOD-M", providerVariantId: "7019" },
          }),
        ],
      }),
    );

    await fulfillmentService.submitOrder(TENANT, "order_1");

    const [input] = createOrderMock().mock.calls[0];
    expect(input.items).toEqual([
      { sku: "HOOD-M", quantity: 3, providerVariantId: "7019" },
    ]);
  });

  it("omits optional line2/state when the order has none", async () => {
    findForFulfillment.mockResolvedValue(
      fulfillmentOrder({ shipLine2: null, shipState: null }),
    );

    await fulfillmentService.submitOrder(TENANT, "order_1");

    const [input] = createOrderMock().mock.calls[0];
    expect(input.shippingAddress.line2).toBeUndefined();
    expect(input.shippingAddress.state).toBeUndefined();
  });

  it("throws FulfillmentNotConfiguredError when no provider is configured", async () => {
    getProvider.mockReturnValue(null);

    await expect(
      fulfillmentService.submitOrder(TENANT, "order_1"),
    ).rejects.toBeInstanceOf(FulfillmentNotConfiguredError);
    // Never even reads the order it could not submit anywhere.
    expect(findForFulfillment).not.toHaveBeenCalled();
  });

  it("throws OrderNotFoundError when no order matches the tenant", async () => {
    findForFulfillment.mockResolvedValue(null);

    await expect(
      fulfillmentService.submitOrder(TENANT, "missing"),
    ).rejects.toBeInstanceOf(OrderNotFoundError);
    expect(createOrderMock()).not.toHaveBeenCalled();
  });

  it("fails all-or-nothing with FulfillmentNotMappedError when any line is unmapped", async () => {
    findForFulfillment.mockResolvedValue(
      fulfillmentOrder({
        items: [
          item(),
          item({
            id: "item_2",
            variantId: "v2",
            variant: { sku: "HOOD-M", providerVariantId: null },
          }),
        ],
      }),
    );

    const err = await fulfillmentService
      .submitOrder(TENANT, "order_1")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FulfillmentNotMappedError);
    expect((err as FulfillmentNotMappedError).skus).toEqual(["HOOD-M"]);
    // No partial submission: the provider is never called.
    expect(createOrderMock()).not.toHaveBeenCalled();
  });

  it("reports an unmapped line before a missing address when both are wrong", async () => {
    // Locks the deliberate check order (mapping before address): the expected,
    // admin-fixable failure wins over the should-never-happen address anomaly.
    findForFulfillment.mockResolvedValue(
      fulfillmentOrder({
        shipName: null,
        shipLine1: null,
        shipCity: null,
        shipPostalCode: null,
        shipCountry: null,
        items: [item({ variant: { sku: "HOOD-M", providerVariantId: null } })],
      }),
    );

    await expect(
      fulfillmentService.submitOrder(TENANT, "order_1"),
    ).rejects.toBeInstanceOf(FulfillmentNotMappedError);
    expect(createOrderMock()).not.toHaveBeenCalled();
  });

  it("throws FulfillmentAddressMissingError when the order has no shipping address", async () => {
    findForFulfillment.mockResolvedValue(
      fulfillmentOrder({
        shipName: null,
        shipLine1: null,
        shipCity: null,
        shipPostalCode: null,
        shipCountry: null,
      }),
    );

    await expect(
      fulfillmentService.submitOrder(TENANT, "order_1"),
    ).rejects.toBeInstanceOf(FulfillmentAddressMissingError);
    expect(createOrderMock()).not.toHaveBeenCalled();
  });

  it("passes a soft provider rejection through as a failed result (does not throw)", async () => {
    findForFulfillment.mockResolvedValue(
      fulfillmentOrder({
        items: [
          item({
            variant: { sku: "BAD", providerVariantId: MOCK_FAILING_VARIANT_ID },
          }),
        ],
      }),
    );

    const result = await fulfillmentService.submitOrder(TENANT, "order_1");

    expect(result.status).toBe("failed");
  });
});
