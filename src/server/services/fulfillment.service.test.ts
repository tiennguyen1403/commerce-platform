import { describe, it, expect, beforeEach, vi } from "vitest";
import { getFulfillmentProvider } from "@/server/fulfillment";
import {
  MockProvider,
  MOCK_FAILING_VARIANT_ID,
} from "@/server/fulfillment/mock";
import {
  fulfillmentService,
  ERROR_POLL_ALERT_THRESHOLD,
} from "@/server/services/fulfillment.service";
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
    markFulfillmentStuck: vi.fn(),
    markStuckRepolled: vi.fn(),
    recordFulfillmentPollError: vi.fn(),
    resetFulfillmentPollErrors: vi.fn(),
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
const markFulfillmentStuck = vi.mocked(orderRepository.markFulfillmentStuck);
const markStuckRepolled = vi.mocked(orderRepository.markStuckRepolled);
const recordFulfillmentPollError = vi.mocked(
  orderRepository.recordFulfillmentPollError,
);
const resetFulfillmentPollErrors = vi.mocked(
  orderRepository.resetFulfillmentPollErrors,
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
    fulfillmentStuckAt: null,
    fulfillmentStuckPolledAt: null,
    fulfillmentErrorCount: 0,
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
  markFulfillmentStuck.mockResolvedValue(true);
  markStuckRepolled.mockResolvedValue(undefined);
  // A low, sub-threshold streak by default: a transient getTracking fault stays
  // "errored" and never alerts, so every pre-existing poll case is unaffected. The
  // #163-specific tests override the returned count to drive the surface-once path.
  recordFulfillmentPollError.mockResolvedValue(1);
  resetFulfillmentPollErrors.mockResolvedValue(undefined);
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

/** A `SubmittedOrderForPolling` row as `findSubmittedForPolling` returns it.
 *  `createdAt` defaults to now — well under the stuck threshold (10 days by default) — so every
 *  pre-existing pollOpenShipments case (which doesn't care about age) stays
 *  "pending"/"shipped"/"failed" as before and is never spuriously flagged stuck;
 *  the stuck-specific tests override it to `STUCK_AGO`. `fulfillmentStuckAt`
 *  defaults to null — not yet surfaced — mirroring a freshly-SUBMITTED order.
 *  `fulfillmentErrorCount` defaults to 0 — no error streak — so a clean poll never
 *  triggers a reset; the #163 tests override it (and the mocked count) to drive the
 *  erroring path. */
function submitted(
  o: Partial<SubmittedOrderForPolling> = {},
): SubmittedOrderForPolling {
  return {
    id: "order_1",
    tenantId: TENANT,
    fulfillmentExternalId: EXTERNAL_ID,
    createdAt: new Date(),
    fulfillmentStuckAt: null,
    fulfillmentErrorCount: 0,
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
      items: [
        {
          sku: "TEE-S",
          quantity: 2,
          priceCents: 1500,
          providerVariantId: "4011",
        },
      ],
      shippingAddress: {
        name: "Ada Lovelace",
        line1: "1 Analytical Ave",
        line2: "Apt 2",
        city: "San Francisco",
        state: "CA",
        postalCode: "94103",
        country: "US",
      },
      // The order's currency rides on the input so the adapter can frame the slip
      // in it (M4 #157) — order-level, from the fixture's `currency: "usd"`.
      currency: "usd",
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
      {
        sku: "HOOD-M",
        quantity: 3,
        priceCents: 1500,
        providerVariantId: "7019",
      },
    ]);
  });

  it("threads each line's snapshot unit price (cents) into the provider input", async () => {
    findForFulfillment.mockResolvedValue(
      fulfillmentOrder({ items: [item({ priceCents: 4599, quantity: 3 })] }),
    );

    await fulfillmentService.submitOrder(TENANT, "order_1");

    const [input] = createOrderMock().mock.calls[0];
    // The per-unit snapshot price (OrderItem.priceCents) rides on the line as cents,
    // straight through — never multiplied by quantity, never re-read from the variant.
    expect(input.items).toEqual([
      {
        sku: "TEE-S",
        quantity: 3,
        priceCents: 4599,
        providerVariantId: "4011",
      },
    ]);
  });

  it("threads the order's currency onto the input (multi-currency slip framing)", async () => {
    // A tenant transacting in a currency other than USD: the order's own currency
    // rides on the input so the adapter can frame the packing slip in it, not the
    // provider account's default (M4 #157). Carried verbatim (lowercase domain code)
    // — the adapter is the only place it becomes Printful's uppercase form.
    findForFulfillment.mockResolvedValue(fulfillmentOrder({ currency: "eur" }));

    await fulfillmentService.submitOrder(TENANT, "order_1");

    const [input] = createOrderMock().mock.calls[0];
    expect(input.currency).toBe("eur");
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
      stuck: 0,
      pending: 0,
      errored: 0,
      erroring: 0,
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
      stuck: 0,
      pending: 1,
      errored: 0,
      erroring: 0,
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
      stuck: 0,
      pending: 0,
      errored: 0,
      erroring: 0,
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
      stuck: 0,
      pending: 1,
      errored: 0,
      erroring: 0,
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
      stuck: 0,
      pending: 0,
      errored: 0,
      erroring: 0,
      shippedOrders: [{ tenantId: TENANT, orderId: "order_1" }],
    });
  });

  it("counts a transient getTracking failure as errored, recording the error streak", async () => {
    findSubmittedForPolling.mockResolvedValue([submitted()]);
    getTrackingMock().mockRejectedValue(new Error("printful 503"));

    const result = await fulfillmentService.pollOpenShipments();

    expect(markShipped).not.toHaveBeenCalled();
    // Every errored poll records the streak (the durable #163 signal); the default
    // sub-threshold count (1) keeps it "errored", not "erroring", so no alert this run.
    expect(recordFulfillmentPollError).toHaveBeenCalledWith(TENANT, "order_1");
    expect(result).toEqual({
      shipped: 0,
      failed: 0,
      stuck: 0,
      pending: 0,
      errored: 1,
      erroring: 0,
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
      stuck: 0,
      pending: 1,
      errored: 0,
      erroring: 0,
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
    // The null-externalId anomaly is a distinct, already-loud (per-run ERROR) failure —
    // NOT a getTracking error streak — so it deliberately does not touch the #163 counter.
    expect(recordFulfillmentPollError).not.toHaveBeenCalled();
    expect(result).toEqual({
      shipped: 0,
      failed: 0,
      stuck: 0,
      pending: 0,
      errored: 1,
      erroring: 0,
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
      stuck: 0,
      pending: 0,
      errored: 1,
      erroring: 0,
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
      stuck: 0,
      pending: 0,
      errored: 0,
      erroring: 0,
      shippedOrders: [],
    });
  });
});

describe("fulfillmentService.pollOpenShipments — stuck open shipment (#155)", () => {
  // Comfortably past STUCK_SUBMITTED_THRESHOLD_MS (10 days), anchored on `createdAt`
  // — the age anchor `flagIfStuck` reads. A wide margin keeps the case robust to a
  // threshold tweak (an operator-tunable knob).
  const STUCK_AGO = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);

  it("surfaces a stuck open shipment once (SUBMITTED past the threshold), leaving fulfillmentStatus untouched", async () => {
    findSubmittedForPolling.mockResolvedValue([
      submitted({ createdAt: STUCK_AGO, fulfillmentStuckAt: null }),
    ]);
    // A provider hold: no tracking number, no terminal failure — genuinely in
    // flight, but too long in flight.
    getTrackingMock().mockResolvedValue({ status: "onhold" });
    markFulfillmentStuck.mockResolvedValue(true);

    const result = await fulfillmentService.pollOpenShipments();

    // The raw provider status this poll read is threaded through so the marker can
    // snapshot it into `fulfillmentProviderStatus` for the admin view (#161).
    expect(markFulfillmentStuck).toHaveBeenCalledWith(
      TENANT,
      "order_1",
      "onhold",
    );
    expect(markFulfillmentStuck).toHaveBeenCalledOnce();
    // #155 is the deliberate inverse of the #151 terminal-fail exit: the order is
    // surfaced but NOT terminalized — fulfillmentStatus stays SUBMITTED — so neither
    // terminal-exit writer ever runs.
    expect(markShipped).not.toHaveBeenCalled();
    expect(markFulfillmentFailedAfterSubmission).not.toHaveBeenCalled();
    // The rotation key (#164) is seeded INSIDE markFulfillmentStuck on the flagging run,
    // not via a re-poll bump — markStuckRepolled fires only on LATER re-polls of an
    // already-flagged order, so it must not be called the run the order is first flagged.
    expect(markStuckRepolled).not.toHaveBeenCalled();
    expect(result).toEqual({
      shipped: 0,
      failed: 0,
      stuck: 1,
      pending: 0,
      errored: 0,
      erroring: 0,
      shippedOrders: [],
    });
  });

  it("re-polls an order already surfaced as stuck — bumps its rotation key (#164), never re-alerts", async () => {
    findSubmittedForPolling.mockResolvedValue([
      submitted({ createdAt: STUCK_AGO, fulfillmentStuckAt: new Date() }),
    ]);
    getTrackingMock().mockResolvedValue({ status: "onhold" });

    const result = await fulfillmentService.pollOpenShipments();

    // Already surfaced (non-null marker) → no second alert; the guarded stuck-flag write is
    // never attempted again.
    expect(markFulfillmentStuck).not.toHaveBeenCalled();
    // But the flagged tail's round-robin re-poll key IS bumped (#164), so this order sorts
    // to the BACK of the tail next run instead of pinning its front forever — the fix for
    // the >POLL_BATCH_SIZE starvation #158's write-once key left. Counted `pending` (still
    // in flight, not a fresh surface).
    expect(markStuckRepolled).toHaveBeenCalledWith(TENANT, "order_1");
    expect(markStuckRepolled).toHaveBeenCalledOnce();
    expect(result).toEqual({
      shipped: 0,
      failed: 0,
      stuck: 0,
      pending: 1,
      errored: 0,
      erroring: 0,
      shippedOrders: [],
    });
  });

  it("does not flag a recent in-flight order (within the window)", async () => {
    findSubmittedForPolling.mockResolvedValue([
      submitted({ createdAt: new Date(), fulfillmentStuckAt: null }),
    ]);
    getTrackingMock().mockResolvedValue({ status: "onhold" });

    const result = await fulfillmentService.pollOpenShipments();

    expect(markFulfillmentStuck).not.toHaveBeenCalled();
    // A fresh (not-yet-flagged) order isn't in the flagged tail, so its rotation key is
    // never bumped either — the "a not-shipped poll writes nothing" invariant holds.
    expect(markStuckRepolled).not.toHaveBeenCalled();
    expect(result).toEqual({
      shipped: 0,
      failed: 0,
      stuck: 0,
      pending: 1,
      errored: 0,
      erroring: 0,
      shippedOrders: [],
    });
  });

  it("counts a lost stuck-flag race as pending, not stuck", async () => {
    findSubmittedForPolling.mockResolvedValue([
      submitted({ createdAt: STUCK_AGO, fulfillmentStuckAt: null }),
    ]);
    getTrackingMock().mockResolvedValue({ status: "onhold" });
    // The guarded write matched nothing — another run stamped it first, or the
    // order left PAID/SUBMITTED underneath us (refunded/manually fulfilled). A
    // benign no-op, mirroring the markShipped/terminal-fail race paths above.
    markFulfillmentStuck.mockResolvedValue(false);

    const result = await fulfillmentService.pollOpenShipments();

    expect(markFulfillmentStuck).toHaveBeenCalledOnce();
    expect(result).toEqual({
      shipped: 0,
      failed: 0,
      stuck: 0,
      pending: 1,
      errored: 0,
      erroring: 0,
      shippedOrders: [],
    });
  });

  it("a shipment still wins over the stuck check", async () => {
    findSubmittedForPolling.mockResolvedValue([
      submitted({ createdAt: STUCK_AGO, fulfillmentStuckAt: null }),
    ]);
    // Old enough to be stuck, but the provider reports a real shipment this poll —
    // the tracking-number branch runs (and wins) before the stuck check is reached.
    getTrackingMock().mockResolvedValue({
      status: "shipped",
      carrier: "C",
      trackingNumber: "T",
      trackingUrl: "u",
    });
    markShipped.mockResolvedValue(true);

    const result = await fulfillmentService.pollOpenShipments();

    expect(markShipped).toHaveBeenCalledOnce();
    expect(markFulfillmentStuck).not.toHaveBeenCalled();
    expect(result).toEqual({
      shipped: 1,
      failed: 0,
      stuck: 0,
      pending: 0,
      errored: 0,
      erroring: 0,
      shippedOrders: [{ tenantId: TENANT, orderId: "order_1" }],
    });
  });
});

describe("fulfillmentService.pollOpenShipments — erroring open shipment (#163)", () => {
  it("surfaces an erroring open shipment once, on the poll whose streak hits the threshold — left SUBMITTED", async () => {
    findSubmittedForPolling.mockResolvedValue([submitted()]);
    // getTracking keeps throwing (a persistent 4xx/5xx, a bad/stale external id): the
    // order can't be reconciled, but this poll is the one whose recorded streak reaches
    // the alert threshold.
    getTrackingMock().mockRejectedValue(new Error("printful 500"));
    recordFulfillmentPollError.mockResolvedValue(ERROR_POLL_ALERT_THRESHOLD);

    const result = await fulfillmentService.pollOpenShipments();

    expect(recordFulfillmentPollError).toHaveBeenCalledWith(TENANT, "order_1");
    // #163 mirrors #155: surface, but do NOT terminalize — a getTracking error means the
    // status is unreadable, not that the order won't ship, so neither terminal writer nor
    // a reset runs, and the order stays SUBMITTED to keep being polled.
    expect(markShipped).not.toHaveBeenCalled();
    expect(markFulfillmentFailedAfterSubmission).not.toHaveBeenCalled();
    expect(markFulfillmentStuck).not.toHaveBeenCalled();
    expect(resetFulfillmentPollErrors).not.toHaveBeenCalled();
    // Counted `erroring` (the surfacing run), not `errored` — as `stuck` splits from `pending`.
    expect(result).toEqual({
      shipped: 0,
      failed: 0,
      stuck: 0,
      pending: 0,
      errored: 0,
      erroring: 1,
      shippedOrders: [],
    });
  });

  it("does not surface below the threshold (a few errors are just 'errored')", async () => {
    findSubmittedForPolling.mockResolvedValue([submitted()]);
    getTrackingMock().mockRejectedValue(new Error("printful 500"));
    recordFulfillmentPollError.mockResolvedValue(
      ERROR_POLL_ALERT_THRESHOLD - 1,
    );

    const result = await fulfillmentService.pollOpenShipments();

    expect(result).toEqual({
      shipped: 0,
      failed: 0,
      stuck: 0,
      pending: 0,
      errored: 1,
      erroring: 0,
      shippedOrders: [],
    });
  });

  it("does not re-surface once past the threshold — the alert fires exactly once", async () => {
    findSubmittedForPolling.mockResolvedValue([submitted()]);
    getTrackingMock().mockRejectedValue(new Error("printful 500"));
    // A later tick: the streak is already past the threshold. The `=== threshold` match
    // (never `>=`) means this run does NOT re-alert — it counts as a plain `errored`.
    recordFulfillmentPollError.mockResolvedValue(
      ERROR_POLL_ALERT_THRESHOLD + 1,
    );

    const result = await fulfillmentService.pollOpenShipments();

    expect(result).toEqual({
      shipped: 0,
      failed: 0,
      stuck: 0,
      pending: 0,
      errored: 1,
      erroring: 0,
      shippedOrders: [],
    });
  });

  it("counts a lost record-error race (null return) as errored, not erroring", async () => {
    findSubmittedForPolling.mockResolvedValue([submitted()]);
    getTrackingMock().mockRejectedValue(new Error("printful 500"));
    // The guarded increment matched nothing — the order left PAID/SUBMITTED (refunded /
    // manually fulfilled) between the select and the write. A benign no-op: no alert, and
    // the getTracking fault this run is still counted `errored`. Mirrors the stuck-flag /
    // markShipped race paths.
    recordFulfillmentPollError.mockResolvedValue(null);

    const result = await fulfillmentService.pollOpenShipments();

    expect(recordFulfillmentPollError).toHaveBeenCalledOnce();
    expect(result).toEqual({
      shipped: 0,
      failed: 0,
      stuck: 0,
      pending: 0,
      errored: 1,
      erroring: 0,
      shippedOrders: [],
    });
  });

  it("resets a non-zero error streak on a clean poll (transient blips recover silently)", async () => {
    // The order errored a few times (streak = 3) but this poll reads tracking cleanly —
    // still in flight (no tracking number, not terminal), created recently so not stuck.
    // The streak must be zeroed so those transient blips can never accumulate to the
    // alert threshold (the #163 "recover silently" invariant, AC3).
    findSubmittedForPolling.mockResolvedValue([
      submitted({ fulfillmentErrorCount: 3 }),
    ]);
    getTrackingMock().mockResolvedValue({ status: "inprocess" });

    const result = await fulfillmentService.pollOpenShipments();

    expect(resetFulfillmentPollErrors).toHaveBeenCalledWith(TENANT, "order_1");
    expect(recordFulfillmentPollError).not.toHaveBeenCalled();
    expect(result).toEqual({
      shipped: 0,
      failed: 0,
      stuck: 0,
      pending: 1,
      errored: 0,
      erroring: 0,
      shippedOrders: [],
    });
  });

  it("does not write a reset on a clean poll when the streak is already zero (no-op poll stays write-free)", async () => {
    findSubmittedForPolling.mockResolvedValue([
      submitted({ fulfillmentErrorCount: 0 }),
    ]);
    getTrackingMock().mockResolvedValue({ status: "inprocess" });

    const result = await fulfillmentService.pollOpenShipments();

    // A never-errored, in-flight order writes NOTHING — the "a not-shipped poll writes
    // nothing" invariant the reset must not break.
    expect(resetFulfillmentPollErrors).not.toHaveBeenCalled();
    expect(result).toEqual({
      shipped: 0,
      failed: 0,
      stuck: 0,
      pending: 1,
      errored: 0,
      erroring: 0,
      shippedOrders: [],
    });
  });

  it("does not reset the streak when the order ships (it leaves the work list)", async () => {
    // A prior streak on an order that ships this run: the ship path leaves the SUBMITTED
    // work list, so the residual count is inert and no reset write is spent on it — the
    // reset is scoped to the stays-SUBMITTED clean-poll branch.
    findSubmittedForPolling.mockResolvedValue([
      submitted({ fulfillmentErrorCount: 5 }),
    ]);
    getTrackingMock().mockResolvedValue({
      status: "shipped",
      trackingNumber: "1Z999",
    });

    const result = await fulfillmentService.pollOpenShipments();

    expect(markShipped).toHaveBeenCalledOnce();
    expect(resetFulfillmentPollErrors).not.toHaveBeenCalled();
    expect(result).toEqual({
      shipped: 1,
      failed: 0,
      stuck: 0,
      pending: 0,
      errored: 0,
      erroring: 0,
      shippedOrders: [{ tenantId: TENANT, orderId: "order_1" }],
    });
  });

  it("resets the error streak AND flags stuck when a long-held order polls cleanly (the two surfaces are independent)", async () => {
    // Comfortably past the stuck age threshold (10 days), and carrying a non-zero error
    // streak from earlier flaky polls. A clean onhold poll this run both zeroes the error
    // streak (#163) and surfaces the age-based hold (#155) — proving the erroring reset
    // doesn't interfere with the stuck flag; they key off different state.
    const stuckAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    findSubmittedForPolling.mockResolvedValue([
      submitted({
        createdAt: stuckAgo,
        fulfillmentStuckAt: null,
        fulfillmentErrorCount: 4,
      }),
    ]);
    getTrackingMock().mockResolvedValue({ status: "onhold" });
    markFulfillmentStuck.mockResolvedValue(true);

    const result = await fulfillmentService.pollOpenShipments();

    expect(resetFulfillmentPollErrors).toHaveBeenCalledWith(TENANT, "order_1");
    expect(markFulfillmentStuck).toHaveBeenCalledWith(
      TENANT,
      "order_1",
      "onhold",
    );
    expect(result).toEqual({
      shipped: 0,
      failed: 0,
      stuck: 1,
      pending: 0,
      errored: 0,
      erroring: 0,
      shippedOrders: [],
    });
  });
});
