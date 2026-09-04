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
  type SubmittedOrderForPolling,
} from "@/server/repositories/order.repository";
import { OrderNotFoundError } from "@/server/order.errors";
import {
  FulfillmentAddressMissingError,
  FulfillmentNotConfiguredError,
  FulfillmentNotMappedError,
  FulfillmentRejectedError,
} from "@/server/fulfillment.errors";

/**
 * Unit tests for the fulfillment service, run entirely against the deterministic
 * mock provider with the order repository mocked (no DB). The provider selector is
 * mocked at the same seam `order.service.test.ts` mocks `getStripe`. Under test is
 * everything the SERVICE owns: the not-configured guard, the tenant-scoped read,
 * the all-or-nothing `sku → providerVariantId` resolution, the address narrowing,
 * the exact `CreateFulfillmentInput` handed to the provider, the two-layer
 * idempotency (the order-level NOT_SUBMITTED → SUBMITTING claim gating the provider
 * call), and the outcome persistence — SUBMITTED with the external id on success,
 * FAILED on every permanent failure, and *nothing* (order left SUBMITTING) on a
 * transient provider fault. The DB-level atomicity of the claim itself is proven in
 * `order.repository.integration.test.ts`, not here.
 */

vi.mock("@/server/fulfillment", () => ({ getFulfillmentProvider: vi.fn() }));
vi.mock("@/server/repositories/order.repository", () => ({
  orderRepository: {
    findForFulfillment: vi.fn(),
    claimForSubmission: vi.fn(),
    markSubmitted: vi.fn(),
    markFulfillmentFailed: vi.fn(),
    findSubmittedForPolling: vi.fn(),
    markShipped: vi.fn(),
    markFulfillmentFailedAfterSubmission: vi.fn(),
  },
}));

const getProvider = vi.mocked(getFulfillmentProvider);
const findForFulfillment = vi.mocked(orderRepository.findForFulfillment);
const claimForSubmission = vi.mocked(orderRepository.claimForSubmission);
const markSubmitted = vi.mocked(orderRepository.markSubmitted);
const markFulfillmentFailed = vi.mocked(orderRepository.markFulfillmentFailed);
const findSubmittedForPolling = vi.mocked(
  orderRepository.findSubmittedForPolling,
);
const markShipped = vi.mocked(orderRepository.markShipped);
const markFulfillmentFailedAfterSubmission = vi.mocked(
  orderRepository.markFulfillmentFailedAfterSubmission,
);

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
  // assert the exact input AND get a real submitted/failed result back. The poll
  // tests override `getTracking` per-case for a deterministic tracking snapshot.
  vi.spyOn(provider, "createOrder");
  vi.spyOn(provider, "getTracking");
  getProvider.mockReturnValue(provider);
  // Happy-path repository defaults; individual tests override.
  findForFulfillment.mockResolvedValue(fulfillmentOrder());
  claimForSubmission.mockResolvedValue(true);
  markSubmitted.mockResolvedValue(true);
  markFulfillmentFailed.mockResolvedValue(undefined);
  findSubmittedForPolling.mockResolvedValue([]);
  markShipped.mockResolvedValue(true);
  markFulfillmentFailedAfterSubmission.mockResolvedValue(true);
});

/** The spied `createOrder`, typed for `.mock`/`toHaveBeenCalled*` assertions. */
function createOrderMock() {
  return vi.mocked(provider.createOrder);
}

/** The spied `getTracking`, typed for `.mockResolvedValue`/assertions. */
function getTrackingMock() {
  return vi.mocked(provider.getTracking);
}

const EXTERNAL_ID = "mock_order_1";

/** A `SubmittedOrderForPolling` row as `findSubmittedForPolling` returns it. */
function submitted(
  o: Partial<SubmittedOrderForPolling> = {},
): SubmittedOrderForPolling {
  return {
    id: "order_1",
    tenantId: TENANT,
    fulfillmentExternalId: EXTERNAL_ID,
    ...o,
  };
}

describe("fulfillmentService.submitOrder — submission + persistence", () => {
  it("claims, submits the built CreateFulfillmentInput, and persists SUBMITTED", async () => {
    findForFulfillment.mockResolvedValue(fulfillmentOrder());

    await fulfillmentService.submitOrder(TENANT, "order_1");

    expect(findForFulfillment).toHaveBeenCalledWith(TENANT, "order_1");
    // Layer-2 guard is claimed before the provider is ever called.
    expect(claimForSubmission).toHaveBeenCalledWith(TENANT, "order_1");
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
    // Success persists the provider's external id + name and moves to SUBMITTED.
    expect(markSubmitted).toHaveBeenCalledWith(
      TENANT,
      "order_1",
      "mock_order_1",
      "mock",
    );
    expect(markFulfillmentFailed).not.toHaveBeenCalled();
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
});

describe("fulfillmentService.submitOrder — idempotency (the SUBMITTING claim)", () => {
  it("does not call the provider — or persist — when the claim is lost", async () => {
    // The order is already SUBMITTING/SUBMITTED/SHIPPED/FAILED, or a concurrent
    // worker won the claim: this attempt must NOT re-submit. Returning without a
    // throw settles the outbox message SENT; a stuck-SUBMITTING order stays put for
    // a human (never auto-resubmitted).
    claimForSubmission.mockResolvedValue(false);

    await expect(
      fulfillmentService.submitOrder(TENANT, "order_1"),
    ).resolves.toBeUndefined();

    expect(createOrderMock()).not.toHaveBeenCalled();
    expect(markSubmitted).not.toHaveBeenCalled();
    expect(markFulfillmentFailed).not.toHaveBeenCalled();
  });

  it("claims BEFORE submitting (guard precedes the provider call)", async () => {
    const order: string[] = [];
    claimForSubmission.mockImplementation(async () => {
      order.push("claim");
      return true;
    });
    createOrderMock().mockImplementation(async () => {
      order.push("createOrder");
      return { externalId: "mock_order_1", status: "submitted" as const };
    });

    await fulfillmentService.submitOrder(TENANT, "order_1");

    expect(order).toEqual(["claim", "createOrder"]);
  });
});

describe("fulfillmentService.submitOrder — permanent failures record FAILED", () => {
  it("marks FAILED and throws FulfillmentNotConfiguredError when no provider is configured", async () => {
    getProvider.mockReturnValue(null);

    await expect(
      fulfillmentService.submitOrder(TENANT, "order_1"),
    ).rejects.toBeInstanceOf(FulfillmentNotConfiguredError);
    // Never even reads the order it could not submit anywhere...
    expect(findForFulfillment).not.toHaveBeenCalled();
    // ...but records the order FAILED so the admin sees a terminal state.
    expect(markFulfillmentFailed).toHaveBeenCalledWith(TENANT, "order_1");
  });

  it("marks FAILED (all-or-nothing) with FulfillmentNotMappedError when any line is unmapped", async () => {
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
    // No partial submission and no claim: the provider is never called, and the
    // order is recorded FAILED (still NOT_SUBMITTED → FAILED, never claimed).
    expect(claimForSubmission).not.toHaveBeenCalled();
    expect(createOrderMock()).not.toHaveBeenCalled();
    expect(markFulfillmentFailed).toHaveBeenCalledWith(TENANT, "order_1");
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

  it("marks FAILED and throws FulfillmentAddressMissingError when the order has no shipping address", async () => {
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
    expect(claimForSubmission).not.toHaveBeenCalled();
    expect(createOrderMock()).not.toHaveBeenCalled();
    expect(markFulfillmentFailed).toHaveBeenCalledWith(TENANT, "order_1");
  });

  it("marks FAILED and throws FulfillmentRejectedError on a soft provider rejection", async () => {
    findForFulfillment.mockResolvedValue(
      fulfillmentOrder({
        items: [
          item({
            variant: { sku: "BAD", providerVariantId: MOCK_FAILING_VARIANT_ID },
          }),
        ],
      }),
    );

    const err = await fulfillmentService
      .submitOrder(TENANT, "order_1")
      .catch((e: unknown) => e);

    // A soft "failed" result is a resolved value from the provider, promoted to a
    // permanent error here so the outbox settles the message DEAD.
    expect(err).toBeInstanceOf(FulfillmentRejectedError);
    expect((err as FulfillmentRejectedError).provider).toBe("mock");
    // Recorded FAILED (from SUBMITTING), and NOT persisted as SUBMITTED — the
    // provider's placeholder id must never be stored.
    expect(markFulfillmentFailed).toHaveBeenCalledWith(TENANT, "order_1");
    expect(markSubmitted).not.toHaveBeenCalled();
  });
});

describe("fulfillmentService.submitOrder — non-FAILED outcomes", () => {
  it("throws OrderNotFoundError without recording FAILED when no order matches the tenant", async () => {
    findForFulfillment.mockResolvedValue(null);

    await expect(
      fulfillmentService.submitOrder(TENANT, "missing"),
    ).rejects.toBeInstanceOf(OrderNotFoundError);
    // A missing order is not a FulfillmentError — nothing to record, nothing to
    // claim or submit.
    expect(claimForSubmission).not.toHaveBeenCalled();
    expect(createOrderMock()).not.toHaveBeenCalled();
    expect(markFulfillmentFailed).not.toHaveBeenCalled();
  });

  it("leaves the order SUBMITTING (no FAILED) when the provider throws transiently after the claim", async () => {
    // A 5xx/timeout the adapter throws as a plain Error: transient, so the outbox
    // retries. But the SUBMITTING claim is already taken, so a re-drain won't
    // re-submit — the order deliberately stays stuck for manual reconciliation
    // rather than risk a duplicate physical shipment (Printful has no idempotency
    // key). Critically, it must NOT be recorded FAILED.
    createOrderMock().mockRejectedValueOnce(new Error("Printful 503"));

    await expect(
      fulfillmentService.submitOrder(TENANT, "order_1"),
    ).rejects.toThrow("Printful 503");

    expect(claimForSubmission).toHaveBeenCalledOnce();
    expect(markSubmitted).not.toHaveBeenCalled();
    expect(markFulfillmentFailed).not.toHaveBeenCalled();
  });
});

describe("fulfillmentService.pollOpenShipments — reconciliation", () => {
  it("reconciles a shipped order: persists the tracking snapshot via markShipped", async () => {
    findSubmittedForPolling.mockResolvedValue([submitted()]);
    getTrackingMock().mockResolvedValue({
      status: "shipped",
      carrier: "UPS",
      trackingNumber: "1Z999",
      trackingUrl: "https://track.example.test/1Z999",
    });

    const result = await fulfillmentService.pollOpenShipments();

    expect(getTrackingMock()).toHaveBeenCalledWith(EXTERNAL_ID);
    // The raw status becomes fulfillmentProviderStatus; carrier/number/url are the
    // reconciled shipment. Only the tenant-scoped markShipped writes.
    expect(markShipped).toHaveBeenCalledWith(TENANT, "order_1", {
      providerStatus: "shipped",
      carrier: "UPS",
      trackingNumber: "1Z999",
      trackingUrl: "https://track.example.test/1Z999",
    });
    // The shipped order is reported back for the route's immediate email dispatch.
    expect(result).toEqual({
      shipped: 1,
      failed: 0,
      pending: 0,
      errored: 0,
      shippedOrders: [{ tenantId: TENANT, orderId: "order_1" }],
    });
  });

  it("maps a shipment with no carrier/url to nulls (tracking number is the signal)", async () => {
    findSubmittedForPolling.mockResolvedValue([submitted()]);
    // Printful's `fulfilled` with only a tracking number, no carrier/url.
    getTrackingMock().mockResolvedValue({
      status: "fulfilled",
      trackingNumber: "TN-1",
    });

    await fulfillmentService.pollOpenShipments();

    expect(markShipped).toHaveBeenCalledWith(TENANT, "order_1", {
      providerStatus: "fulfilled",
      carrier: null,
      trackingNumber: "TN-1",
      trackingUrl: null,
    });
  });

  it("leaves an unshipped order alone (no tracking number → no markShipped)", async () => {
    findSubmittedForPolling.mockResolvedValue([submitted()]);
    // The provider accepted the order but hasn't shipped it — no tracking number.
    getTrackingMock().mockResolvedValue({ status: "inprocess" });

    const result = await fulfillmentService.pollOpenShipments();

    expect(markShipped).not.toHaveBeenCalled();
    expect(result).toEqual({
      shipped: 0,
      failed: 0,
      pending: 1,
      errored: 0,
      shippedOrders: [],
    });
  });

  it("reconciles a provider terminal failure to FAILED (no tracking number, flagged terminal)", async () => {
    findSubmittedForPolling.mockResolvedValue([submitted()]);
    // The provider cancelled/failed the order after submission: no tracking number,
    // but the adapter flags it terminal (the provider-agnostic signal). It must move
    // to FAILED — not be treated as still-in-flight "pending" and re-polled forever.
    getTrackingMock().mockResolvedValue({
      status: "canceled",
      terminalFailure: true,
    });

    const result = await fulfillmentService.pollOpenShipments();

    // The raw provider status is persisted for admin display; status stays PAID (the
    // repo method owns that) so an operator can refund/re-order.
    expect(markFulfillmentFailedAfterSubmission).toHaveBeenCalledWith(
      TENANT,
      "order_1",
      "canceled",
    );
    // Never a shipment — no markShipped, and it is NOT reported for an email dispatch.
    expect(markShipped).not.toHaveBeenCalled();
    expect(result).toEqual({
      shipped: 0,
      failed: 1,
      pending: 0,
      errored: 0,
      shippedOrders: [],
    });
  });

  it("counts a terminal-fail race (markFulfillmentFailedAfterSubmission=false) as pending", async () => {
    findSubmittedForPolling.mockResolvedValue([submitted()]);
    getTrackingMock().mockResolvedValue({
      status: "failed",
      terminalFailure: true,
    });
    // The guarded reconcile matched nothing — the order left PAID+SUBMITTED (refunded
    // or manually fulfilled) between the find and the write. Mirrors the markShipped
    // race: a benign no-op counted as pending, not a failure we caused this run.
    markFulfillmentFailedAfterSubmission.mockResolvedValue(false);

    const result = await fulfillmentService.pollOpenShipments();

    expect(markFulfillmentFailedAfterSubmission).toHaveBeenCalledOnce();
    expect(result).toEqual({
      shipped: 0,
      failed: 0,
      pending: 1,
      errored: 0,
      shippedOrders: [],
    });
  });

  it("prefers a shipment over a terminal-fail flag (tracking number wins)", async () => {
    findSubmittedForPolling.mockResolvedValue([submitted()]);
    // A defensive edge: a tracking number is present — the order shipped, so it is
    // reconciled to SHIPPED regardless of any terminal-fail flag also being set.
    getTrackingMock().mockResolvedValue({
      status: "fulfilled",
      trackingNumber: "TN-1",
      terminalFailure: true,
    });

    const result = await fulfillmentService.pollOpenShipments();

    expect(markShipped).toHaveBeenCalledOnce();
    expect(markFulfillmentFailedAfterSubmission).not.toHaveBeenCalled();
    expect(result).toEqual({
      shipped: 1,
      failed: 0,
      pending: 0,
      errored: 0,
      shippedOrders: [{ tenantId: TENANT, orderId: "order_1" }],
    });
  });

  it("counts a transient getTracking failure as errored, without reconciling", async () => {
    findSubmittedForPolling.mockResolvedValue([submitted()]);
    getTrackingMock().mockRejectedValue(new Error("printful 503"));

    const result = await fulfillmentService.pollOpenShipments();

    expect(markShipped).not.toHaveBeenCalled();
    expect(result).toEqual({
      shipped: 0,
      failed: 0,
      pending: 0,
      errored: 1,
      shippedOrders: [],
    });
  });

  it("counts a refunded/fulfilled race (markShipped=false) as pending, not shipped", async () => {
    findSubmittedForPolling.mockResolvedValue([submitted()]);
    getTrackingMock().mockResolvedValue({
      status: "shipped",
      trackingNumber: "1Z999",
    });
    // The guarded reconcile matched nothing — the order left PAID+SUBMITTED
    // (refunded or manually fulfilled) between the find and the write.
    markShipped.mockResolvedValue(false);

    const result = await fulfillmentService.pollOpenShipments();

    expect(markShipped).toHaveBeenCalledOnce();
    expect(result).toEqual({
      shipped: 0,
      failed: 0,
      pending: 1,
      errored: 0,
      shippedOrders: [],
    });
  });

  it("skips an order with no fulfillmentExternalId (errored, never calls the provider)", async () => {
    findSubmittedForPolling.mockResolvedValue([
      submitted({ fulfillmentExternalId: null }),
    ]);

    const result = await fulfillmentService.pollOpenShipments();

    expect(getTrackingMock()).not.toHaveBeenCalled();
    expect(markShipped).not.toHaveBeenCalled();
    expect(result).toEqual({
      shipped: 0,
      failed: 0,
      pending: 0,
      errored: 1,
      shippedOrders: [],
    });
  });

  it("isolates a markShipped DB error per order and keeps polling the rest", async () => {
    findSubmittedForPolling.mockResolvedValue([
      submitted({ id: "o1", fulfillmentExternalId: "ext1" }),
      submitted({ id: "o2", fulfillmentExternalId: "ext2" }),
    ]);
    getTrackingMock().mockResolvedValue({
      status: "shipped",
      trackingNumber: "TN",
    });
    // The first order's reconcile write blows up; the second must still ship.
    markShipped
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValue(true);

    const result = await fulfillmentService.pollOpenShipments();

    expect(markShipped).toHaveBeenCalledTimes(2);
    // Only the successfully-reconciled order (o2) is reported for dispatch.
    expect(result).toEqual({
      shipped: 1,
      failed: 0,
      pending: 0,
      errored: 1,
      shippedOrders: [{ tenantId: TENANT, orderId: "o2" }],
    });
  });

  it("returns zeros and queries nothing when no provider is configured", async () => {
    getProvider.mockReturnValue(null);

    const result = await fulfillmentService.pollOpenShipments();

    expect(findSubmittedForPolling).not.toHaveBeenCalled();
    expect(result).toEqual({
      shipped: 0,
      failed: 0,
      pending: 0,
      errored: 0,
      shippedOrders: [],
    });
  });
});
