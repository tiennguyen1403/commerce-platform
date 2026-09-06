import { describe, it, expect, beforeEach, vi } from "vitest";
import type Stripe from "stripe";
import type { Order, OrderItem } from "@prisma/client";
import { getStripe } from "@/lib/stripe";
import { cartService, type CartView } from "@/server/services/cart.service";
import { orderService } from "@/server/services/order.service";
import {
  orderRepository,
  type OrderWithItems,
} from "@/server/repositories/order.repository";
import {
  EmptyCartError,
  OrderNumberTakenError,
  InsufficientStockError,
  OrderNotFoundError,
  OrderTransitionError,
} from "@/server/order.errors";
import type { CartItem } from "@/lib/cart";
import type { ShippingAddress } from "@/server/fulfillment/provider";

/**
 * Unit tests for the checkout service, with Stripe and the order repository
 * mocked and the cart service stubbed (it has its own suite). The behaviours
 * under test are the ones the service — not the repository — owns: the
 * order-number-collision retry loop, the best-effort intent cancel that swallows
 * its own failures, and the three-way `markOrderPaid` outcome.
 */

vi.mock("@/lib/stripe", () => ({ getStripe: vi.fn() }));
vi.mock("@/server/services/cart.service", () => ({
  cartService: { getCartView: vi.fn(), resolveLine: vi.fn() },
}));
vi.mock("@/server/repositories/order.repository", () => ({
  orderRepository: {
    createWithItems: vi.fn(),
    markPaidByPaymentIntent: vi.fn(),
    findByPaymentIntentForTenant: vi.fn(),
    findByIdForTenant: vi.fn(),
    findStalePending: vi.fn(),
    findReusablePendingCandidates: vi.fn(),
    cancelPendingAndRelease: vi.fn(),
    markFulfilled: vi.fn(),
    markRefundedByPaymentIntent: vi.fn(),
    updateShippingAddressForPending: vi.fn(),
  },
}));
// The sweep logs through pino; stub it so tests emit no lines and never load pino.
vi.mock("@/server/observability/logger", () => {
  const stub = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => stub,
  };
  return { logger: stub };
});

// A minimal Stripe stand-in — only the PaymentIntent + Refund calls the service
// makes.
const paymentIntents = {
  create: vi.fn(),
  retrieve: vi.fn(),
  cancel: vi.fn(),
};
const refunds = { create: vi.fn() };
const fakeStripe = { paymentIntents, refunds } as unknown as Stripe;

const getCartView = vi.mocked(cartService.getCartView);
const createWithItems = vi.mocked(orderRepository.createWithItems);
const markPaid = vi.mocked(orderRepository.markPaidByPaymentIntent);
const findById = vi.mocked(orderRepository.findByIdForTenant);
const findStale = vi.mocked(orderRepository.findStalePending);
const findReusable = vi.mocked(orderRepository.findReusablePendingCandidates);
const cancelRepo = vi.mocked(orderRepository.cancelPendingAndRelease);
const fulfillRepo = vi.mocked(orderRepository.markFulfilled);
const markRefunded = vi.mocked(orderRepository.markRefundedByPaymentIntent);
const updateShipAddr = vi.mocked(
  orderRepository.updateShippingAddressForPending,
);

const TENANT = "tenant_1";
const EMAIL = "shopper@example.com";
// A valid US shipping address threaded through every startCheckout call (#135).
const SHIPPING: ShippingAddress = {
  name: "Ada Lovelace",
  line1: "1 Analytical Ave",
  line2: "Apt 2",
  city: "San Francisco",
  state: "CA",
  postalCode: "94103",
  country: "US",
};
// Bound in the service (`MAX_ORDER_NUMBER_ATTEMPTS`); duplicated here as the
// expected retry ceiling.
const MAX_ORDER_NUMBER_ATTEMPTS = 5;

function cartItem(o: Partial<CartItem> = {}): CartItem {
  return {
    variantId: "v1",
    productSlug: "tee",
    productTitle: "Tee",
    variantName: "Blue",
    unitPriceCents: 1500,
    currency: "usd",
    qty: 2,
    lineTotalCents: 3000,
    available: 10,
    image: null,
    ...o,
  };
}

function cartView(o: Partial<CartView> = {}): CartView {
  const items = o.items ?? [cartItem()];
  return {
    items,
    totalCents: o.totalCents ?? items.reduce((s, i) => s + i.lineTotalCents, 0),
    currency: o.currency ?? "usd",
    itemCount: o.itemCount ?? items.reduce((s, i) => s + i.qty, 0),
    removedCount: o.removedCount ?? 0,
    adjusted: o.adjusted ?? false,
  };
}

function order(o: Partial<Order> = {}): Order {
  return {
    id: "order_1",
    tenantId: TENANT,
    orderNumber: "20250101-AAA111",
    status: "PENDING",
    email: EMAIL,
    userId: null,
    totalCents: 3000,
    currency: "usd",
    stripePaymentIntentId: "pi_1",
    oversold: false,
    // Fulfillment (M4 #134): nullable/defaulted columns, unset in this fixture.
    shipName: null,
    shipLine1: null,
    shipLine2: null,
    shipCity: null,
    shipState: null,
    shipPostalCode: null,
    shipCountry: null,
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
    fulfillmentErrorPolledAt: null,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    updatedAt: new Date("2025-01-01T00:00:00.000Z"),
    ...o,
  };
}

function orderItem(o: Partial<OrderItem> = {}): OrderItem {
  return {
    id: "item_1",
    orderId: "order_1",
    variantId: "v1",
    titleSnapshot: "Tee — Blue",
    priceCents: 1500,
    quantity: 2,
    ...o,
  };
}

function orderWithItems(o: Partial<OrderWithItems> = {}): OrderWithItems {
  return { ...order(), items: [orderItem()], ...o };
}

/** The slim row `findStalePending` returns for the sweep. */
function stalePending(
  o: Partial<{
    id: string;
    tenantId: string;
    stripePaymentIntentId: string | null;
  }> = {},
) {
  return {
    id: "order_1",
    tenantId: TENANT,
    stripePaymentIntentId: "pi_1",
    ...o,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getStripe).mockReturnValue(fakeStripe);
  // Default: no in-flight order to reuse, so startCheckout mints fresh unless a
  // test opts into a reuse candidate. (resetAllMocks clears this each test.)
  findReusable.mockResolvedValue([]);
});

describe("orderService.startCheckout", () => {
  it("creates a PaymentIntent and a PENDING order, returning the client secret", async () => {
    getCartView.mockResolvedValue(
      cartView({
        items: [
          cartItem({ qty: 2, unitPriceCents: 1500, lineTotalCents: 3000 }),
        ],
        totalCents: 3000,
        currency: "usd",
      }),
    );
    paymentIntents.create.mockResolvedValue({
      id: "pi_1",
      client_secret: "cs_1",
    });
    createWithItems.mockResolvedValue(
      order({
        id: "order_1",
        orderNumber: "20250101-AAA111",
        totalCents: 3000,
      }),
    );

    const lines = [{ variantId: "v1", qty: 2 }];
    const result = await orderService.startCheckout(
      TENANT,
      lines,
      EMAIL,
      SHIPPING,
      "usd",
      null,
    );

    expect(getCartView).toHaveBeenCalledWith(TENANT, lines, "usd");
    // Stripe is charged the server-recomputed total in the store currency.
    expect(paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 3000,
        currency: "usd",
        receipt_email: EMAIL,
        automatic_payment_methods: { enabled: true },
        metadata: expect.objectContaining({ tenantId: TENANT }),
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );

    // The pre-generated order id rides in the intent metadata, is the
    // idempotency key, and is what the order row is written under.
    const [params, options] = paymentIntents.create.mock.calls[0] as [
      Stripe.PaymentIntentCreateParams,
      Stripe.RequestOptions,
    ];
    const orderId = params.metadata?.orderId;
    expect(orderId).toBe(options.idempotencyKey);

    const writeInput = createWithItems.mock.calls[0][0];
    expect(writeInput.id).toBe(orderId);
    expect(writeInput).toMatchObject({
      tenantId: TENANT,
      email: EMAIL,
      totalCents: 3000,
      currency: "usd",
      stripePaymentIntentId: "pi_1",
      items: [{ variantId: "v1", priceCents: 1500, quantity: 2 }],
    });
    // Line title is the "product — variant" snapshot the service builds.
    expect(writeInput.items[0].titleSnapshot).toMatch(/^Tee \S Blue$/);
    // Guest checkout (no signed-in shopper resolved) → userId defaults to null.
    expect(writeInput.userId).toBeNull();
    // The validated address is threaded straight to the repository create, to be
    // persisted in the same transaction as the order (#135).
    expect(writeInput.shippingAddress).toEqual(SHIPPING);
    // The PaymentIntent stays payment-only — our form is the single source of
    // shipping truth, so Stripe is never sent an address (#135).
    expect(paymentIntents.create.mock.calls[0][0]).not.toHaveProperty(
      "shipping",
    );

    expect(result).toEqual({
      clientSecret: "cs_1",
      orderId: "order_1",
      orderNumber: "20250101-AAA111",
      totalCents: 3000,
      currency: "usd",
    });
  });

  it("retries with a fresh order number on a collision, then succeeds", async () => {
    getCartView.mockResolvedValue(cartView());
    paymentIntents.create.mockResolvedValue({
      id: "pi_1",
      client_secret: "cs_1",
    });
    createWithItems
      .mockRejectedValueOnce(new OrderNumberTakenError())
      .mockRejectedValueOnce(new OrderNumberTakenError())
      .mockResolvedValueOnce(order());

    await orderService.startCheckout(
      TENANT,
      [{ variantId: "v1", qty: 2 }],
      EMAIL,
      SHIPPING,
      "usd",
      null,
    );

    expect(createWithItems).toHaveBeenCalledTimes(3);
    const numbers = createWithItems.mock.calls.map(([arg]) => arg.orderNumber);
    // The number is regenerated *inside* the loop, so each attempt submits a
    // distinct `YYYYMMDD-XXXXXX` — reusing one would just re-collide forever.
    expect(new Set(numbers).size).toBe(3);
    for (const number of numbers) {
      expect(number).toMatch(/^\d{8}-[0-9A-Z]{6}$/);
    }
    expect(paymentIntents.cancel).not.toHaveBeenCalled();
  });

  it("gives up after the bounded retries and cancels the orphaned intent", async () => {
    getCartView.mockResolvedValue(cartView());
    paymentIntents.create.mockResolvedValue({
      id: "pi_1",
      client_secret: "cs_1",
    });
    paymentIntents.cancel.mockResolvedValue({});
    createWithItems.mockRejectedValue(new OrderNumberTakenError());

    await expect(
      orderService.startCheckout(
        TENANT,
        [{ variantId: "v1", qty: 2 }],
        EMAIL,
        SHIPPING,
        "usd",
        null,
      ),
    ).rejects.toBeInstanceOf(OrderNumberTakenError);

    expect(createWithItems).toHaveBeenCalledTimes(MAX_ORDER_NUMBER_ATTEMPTS);
    expect(paymentIntents.cancel).toHaveBeenCalledWith("pi_1");
  });

  it("propagates InsufficientStockError and cancels the intent without retrying", async () => {
    getCartView.mockResolvedValue(cartView());
    paymentIntents.create.mockResolvedValue({
      id: "pi_1",
      client_secret: "cs_1",
    });
    paymentIntents.cancel.mockResolvedValue({});
    // The reserve guard inside createWithItems turned the order away (sold out).
    createWithItems.mockRejectedValue(new InsufficientStockError());

    await expect(
      orderService.startCheckout(
        TENANT,
        [{ variantId: "v1", qty: 2 }],
        EMAIL,
        SHIPPING,
        "usd",
        null,
      ),
    ).rejects.toBeInstanceOf(InsufficientStockError);

    // Not an order-number collision → no retry; the orphaned intent is cancelled.
    expect(createWithItems).toHaveBeenCalledTimes(1);
    expect(paymentIntents.cancel).toHaveBeenCalledWith("pi_1");
  });

  it("does not retry a non-collision write error, and swallows a cancel failure", async () => {
    getCartView.mockResolvedValue(cartView());
    paymentIntents.create.mockResolvedValue({
      id: "pi_1",
      client_secret: "cs_1",
    });
    const writeError = new Error("db unreachable");
    createWithItems.mockRejectedValue(writeError);
    // Even when cancelling the orphaned intent throws, the original write error
    // must be the one that surfaces.
    paymentIntents.cancel.mockRejectedValue(new Error("stripe cancel failed"));

    await expect(
      orderService.startCheckout(
        TENANT,
        [{ variantId: "v1", qty: 2 }],
        EMAIL,
        SHIPPING,
        "usd",
        null,
      ),
    ).rejects.toBe(writeError);

    expect(createWithItems).toHaveBeenCalledTimes(1);
    expect(paymentIntents.cancel).toHaveBeenCalledWith("pi_1");
  });

  it("throws EmptyCartError and never calls Stripe when the cart reconciles to empty", async () => {
    getCartView.mockResolvedValue(
      cartView({ items: [], totalCents: 0, itemCount: 0 }),
    );

    await expect(
      orderService.startCheckout(TENANT, [], EMAIL, SHIPPING, "usd", null),
    ).rejects.toBeInstanceOf(EmptyCartError);
    expect(paymentIntents.create).not.toHaveBeenCalled();
  });

  it("cancels the intent and throws when Stripe returns no client secret", async () => {
    getCartView.mockResolvedValue(cartView());
    paymentIntents.create.mockResolvedValue({
      id: "pi_2",
      client_secret: null,
    });
    paymentIntents.cancel.mockResolvedValue({});

    await expect(
      orderService.startCheckout(
        TENANT,
        [{ variantId: "v1", qty: 2 }],
        EMAIL,
        SHIPPING,
        "usd",
        null,
      ),
    ).rejects.toThrow("Stripe did not return a client secret");
    expect(paymentIntents.cancel).toHaveBeenCalledWith("pi_2");
    expect(createWithItems).not.toHaveBeenCalled();
  });

  it("links the order to the signed-in shopper's userId (server-resolved)", async () => {
    getCartView.mockResolvedValue(cartView());
    paymentIntents.create.mockResolvedValue({
      id: "pi_1",
      client_secret: "cs_1",
    });
    createWithItems.mockResolvedValue(order());

    await orderService.startCheckout(
      TENANT,
      [{ variantId: "v1", qty: 2 }],
      EMAIL,
      SHIPPING,
      "usd",
      "user_123",
    );

    expect(createWithItems.mock.calls[0][0].userId).toBe("user_123");
  });
});

describe("orderService.markOrderPaid", () => {
  it("reports 'paid' with the order and any shortfalls on the transition", async () => {
    const paid = orderWithItems();
    const shortfalls = [
      {
        variantId: "v1",
        titleSnapshot: "Tee — Blue",
        ordered: 5,
        available: 2,
      },
    ];
    markPaid.mockResolvedValue({ transitioned: true, order: paid, shortfalls });

    const result = await orderService.markOrderPaid(TENANT, "pi_1");

    expect(markPaid).toHaveBeenCalledWith(TENANT, "pi_1");
    expect(result).toEqual({ outcome: "paid", order: paid, shortfalls });
  });

  it("reports 'already-processed' for a duplicate/late delivery", async () => {
    markPaid.mockResolvedValue({ transitioned: false, orderExisted: true });

    await expect(orderService.markOrderPaid(TENANT, "pi_1")).resolves.toEqual({
      outcome: "already-processed",
    });
  });

  it("reports 'no-order' when no order matches the intent", async () => {
    markPaid.mockResolvedValue({ transitioned: false, orderExisted: false });

    await expect(orderService.markOrderPaid(TENANT, "pi_1")).resolves.toEqual({
      outcome: "no-order",
    });
  });
});

describe("orderService.cancelOrder", () => {
  it("cancels the PaymentIntent, then flips + releases when the intent is still awaiting payment", async () => {
    findById.mockResolvedValue(
      orderWithItems({ id: "order_1", stripePaymentIntentId: "pi_1" }),
    );
    paymentIntents.retrieve.mockResolvedValue({
      id: "pi_1",
      status: "requires_payment_method",
    });
    paymentIntents.cancel.mockResolvedValue({ id: "pi_1", status: "canceled" });
    cancelRepo.mockResolvedValue({ transitioned: true });

    await expect(
      orderService.cancelOrder(TENANT, "order_1"),
    ).resolves.toBeUndefined();
    expect(paymentIntents.cancel).toHaveBeenCalledWith("pi_1");
    expect(cancelRepo).toHaveBeenCalledWith(TENANT, "order_1");
    // Intent retired BEFORE the DB flip — the money-safe ordering (an order is only
    // flipped once its intent can no longer be charged).
    expect(paymentIntents.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      cancelRepo.mock.invocationCallOrder[0],
    );
  });

  it("REFUSES with a non-typed error the boundary reports when the intent can't be verified", async () => {
    findById.mockResolvedValue(
      orderWithItems({ stripePaymentIntentId: "pi_1" }),
    );
    paymentIntents.retrieve.mockRejectedValue(new Error("Stripe unreachable"));

    // Can't confirm the intent is uncharged → refuse rather than cancel blindly.
    await expect(orderService.cancelOrder(TENANT, "order_1")).rejects.toThrow(
      /could not verify/i,
    );
    // NOT a typed lifecycle error, so the action boundary reports it + shows the
    // generic retryable message (never a friendly transition/not-found message).
    await expect(
      orderService.cancelOrder(TENANT, "order_1"),
    ).rejects.not.toBeInstanceOf(OrderTransitionError);
    expect(cancelRepo).not.toHaveBeenCalled();
  });

  it("throws OrderNotFoundError when the order doesn't exist", async () => {
    findById.mockResolvedValue(null);

    await expect(
      orderService.cancelOrder(TENANT, "order_x"),
    ).rejects.toBeInstanceOf(OrderNotFoundError);
    expect(paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(cancelRepo).not.toHaveBeenCalled();
  });

  it("throws OrderTransitionError naming the current status when it isn't PENDING", async () => {
    findById.mockResolvedValue(orderWithItems({ status: "PAID" }));

    // Fails fast on the pre-read — no Stripe call, no flip attempt.
    await expect(orderService.cancelOrder(TENANT, "order_1")).rejects.toThrow(
      /paid/i,
    );
    await expect(
      orderService.cancelOrder(TENANT, "order_1"),
    ).rejects.toBeInstanceOf(OrderTransitionError);
    expect(paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(cancelRepo).not.toHaveBeenCalled();
  });

  it("REFUSES (never cancels) when the intent shows payment in flight", async () => {
    findById.mockResolvedValue(
      orderWithItems({ stripePaymentIntentId: "pi_1" }),
    );
    paymentIntents.retrieve.mockResolvedValue({
      id: "pi_1",
      status: "succeeded",
    });

    await expect(
      orderService.cancelOrder(TENANT, "order_1"),
    ).rejects.toBeInstanceOf(OrderTransitionError);
    // Money-safety: a paying/paid order is never cancelled, and its intent untouched.
    expect(paymentIntents.cancel).not.toHaveBeenCalled();
    expect(cancelRepo).not.toHaveBeenCalled();
  });

  it("REFUSES when the cancel loses the race to a real payment", async () => {
    findById.mockResolvedValue(
      orderWithItems({ stripePaymentIntentId: "pi_1" }),
    );
    paymentIntents.retrieve.mockResolvedValue({
      id: "pi_1",
      status: "requires_payment_method",
    });
    paymentIntents.cancel.mockRejectedValue(
      new Error("payment_intent_unexpected_state"),
    );

    await expect(
      orderService.cancelOrder(TENANT, "order_1"),
    ).rejects.toBeInstanceOf(OrderTransitionError);
    // The intent wasn't provably canceled, so the order is left for the webhook.
    expect(cancelRepo).not.toHaveBeenCalled();
  });

  it("reconciles an already-canceled intent by flipping, without re-cancelling", async () => {
    findById.mockResolvedValue(
      orderWithItems({ id: "order_1", stripePaymentIntentId: "pi_1" }),
    );
    paymentIntents.retrieve.mockResolvedValue({
      id: "pi_1",
      status: "canceled",
    });
    cancelRepo.mockResolvedValue({ transitioned: true });

    await expect(
      orderService.cancelOrder(TENANT, "order_1"),
    ).resolves.toBeUndefined();
    expect(paymentIntents.cancel).not.toHaveBeenCalled();
    expect(cancelRepo).toHaveBeenCalledWith(TENANT, "order_1");
  });

  it("flips an order with no linked intent (anomaly) without touching Stripe", async () => {
    findById.mockResolvedValue(
      orderWithItems({ id: "order_1", stripePaymentIntentId: null }),
    );
    cancelRepo.mockResolvedValue({ transitioned: true });

    await expect(
      orderService.cancelOrder(TENANT, "order_1"),
    ).resolves.toBeUndefined();
    expect(paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(cancelRepo).toHaveBeenCalledWith(TENANT, "order_1");
  });

  it("surfaces a wrong-state race the repository guard catches after the intent is retired", async () => {
    // Pre-read sees PENDING and the intent retires cleanly, but a concurrent actor
    // flips the order first — the guarded transition is the authoritative arbiter.
    findById.mockResolvedValue(
      orderWithItems({ stripePaymentIntentId: "pi_1" }),
    );
    paymentIntents.retrieve.mockResolvedValue({
      id: "pi_1",
      status: "canceled",
    });
    cancelRepo.mockResolvedValue({
      transitioned: false,
      currentStatus: "CANCELLED",
    });

    await expect(orderService.cancelOrder(TENANT, "order_1")).rejects.toThrow(
      /cancelled/i,
    );
  });
});

describe("orderService.fulfillOrder", () => {
  it("delegates to the repository and resolves on a successful transition", async () => {
    fulfillRepo.mockResolvedValue({ transitioned: true });

    await expect(
      orderService.fulfillOrder(TENANT, "order_1"),
    ).resolves.toBeUndefined();
    expect(fulfillRepo).toHaveBeenCalledWith(TENANT, "order_1");
  });

  it("throws OrderNotFoundError when the order doesn't exist", async () => {
    fulfillRepo.mockResolvedValue({ transitioned: false, currentStatus: null });

    await expect(
      orderService.fulfillOrder(TENANT, "order_x"),
    ).rejects.toBeInstanceOf(OrderNotFoundError);
  });

  it("throws OrderTransitionError naming the current status when it isn't PAID", async () => {
    fulfillRepo.mockResolvedValue({
      transitioned: false,
      currentStatus: "PENDING",
    });

    await expect(
      orderService.fulfillOrder(TENANT, "order_1"),
    ).rejects.toBeInstanceOf(OrderTransitionError);
    await expect(orderService.fulfillOrder(TENANT, "order_1")).rejects.toThrow(
      /pending/i,
    );
  });
});

describe("orderService.refundOrder", () => {
  it("initiates a full Stripe refund (no amount) with tenant/order metadata for a PAID order", async () => {
    findById.mockResolvedValue(
      orderWithItems({ status: "PAID", stripePaymentIntentId: "pi_1" }),
    );
    refunds.create.mockResolvedValue({ id: "re_1", status: "pending" });

    await expect(
      orderService.refundOrder(TENANT, "order_1"),
    ).resolves.toBeUndefined();

    expect(findById).toHaveBeenCalledWith(TENANT, "order_1");
    expect(refunds.create).toHaveBeenCalledWith(
      {
        payment_intent: "pi_1",
        reason: "requested_by_customer",
        metadata: { tenantId: TENANT, orderId: "order_1" },
      },
      // Idempotency key mirrors the checkout PaymentIntent — at most one refund.
      { idempotencyKey: "refund_order_1" },
    );
    // Omitting `amount` is what makes it a *full* refund — assert it's absent.
    expect(refunds.create.mock.calls[0][0]).not.toHaveProperty("amount");
  });

  it("also refunds a FULFILLED order", async () => {
    findById.mockResolvedValue(
      orderWithItems({ status: "FULFILLED", stripePaymentIntentId: "pi_9" }),
    );
    refunds.create.mockResolvedValue({ id: "re_2", status: "succeeded" });

    await orderService.refundOrder(TENANT, "order_1");

    expect(refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_9" }),
      expect.objectContaining({ idempotencyKey: "refund_order_1" }),
    );
  });

  it("makes no DB write on initiation — the webhook is the sole writer", async () => {
    findById.mockResolvedValue(orderWithItems({ status: "PAID" }));
    refunds.create.mockResolvedValue({ id: "re_3", status: "pending" });

    await orderService.refundOrder(TENANT, "order_1");

    expect(markRefunded).not.toHaveBeenCalled();
  });

  it("throws OrderNotFoundError and never calls Stripe when the order doesn't exist", async () => {
    findById.mockResolvedValue(null);

    await expect(
      orderService.refundOrder(TENANT, "order_x"),
    ).rejects.toBeInstanceOf(OrderNotFoundError);
    expect(refunds.create).not.toHaveBeenCalled();
  });

  it("throws OrderTransitionError naming the status when the order isn't refundable", async () => {
    findById.mockResolvedValue(orderWithItems({ status: "PENDING" }));

    await expect(
      orderService.refundOrder(TENANT, "order_1"),
    ).rejects.toBeInstanceOf(OrderTransitionError);
    // The refusal message names the blocking status so the admin sees why.
    await expect(orderService.refundOrder(TENANT, "order_1")).rejects.toThrow(
      /pending/i,
    );
    expect(refunds.create).not.toHaveBeenCalled();
  });

  it("throws without calling Stripe when a captured order has no PaymentIntent", async () => {
    findById.mockResolvedValue(
      orderWithItems({ status: "PAID", stripePaymentIntentId: null }),
    );

    await expect(orderService.refundOrder(TENANT, "order_1")).rejects.toThrow(
      /no linked PaymentIntent/i,
    );
    expect(refunds.create).not.toHaveBeenCalled();
  });
});

describe("orderService.markOrderRefunded", () => {
  it("reports 'refunded' on the transition", async () => {
    markRefunded.mockResolvedValue({ transitioned: true });

    await expect(
      orderService.markOrderRefunded(TENANT, "pi_1"),
    ).resolves.toEqual({ outcome: "refunded" });
    expect(markRefunded).toHaveBeenCalledWith(TENANT, "pi_1");
  });

  it("reports 'already-processed' with the current status when the order exists but didn't move", async () => {
    markRefunded.mockResolvedValue({
      transitioned: false,
      currentStatus: "REFUNDED",
    });

    await expect(
      orderService.markOrderRefunded(TENANT, "pi_1"),
    ).resolves.toEqual({
      outcome: "already-processed",
      currentStatus: "REFUNDED",
    });
  });

  it("reports 'no-order' when no order matches the intent", async () => {
    markRefunded.mockResolvedValue({
      transitioned: false,
      currentStatus: null,
    });

    await expect(
      orderService.markOrderRefunded(TENANT, "pi_1"),
    ).resolves.toEqual({ outcome: "no-order" });
  });
});

/**
 * Reuse an in-flight PaymentIntent on a re-submit (#25 dedupe). The behaviour the
 * service owns: match a recent PENDING order to the freshly re-priced cart, verify
 * the linked intent is still reusable, and hand back its existing client secret —
 * minting nothing new — or fall through to a fresh create on any miss.
 */
describe("orderService.startCheckout — reuse in-flight intent", () => {
  /** A reusable candidate: a PENDING order for this cart with a still-awaiting PI. */
  function reusableCandidate(): OrderWithItems {
    return orderWithItems({
      id: "order_existing",
      orderNumber: "20250101-OLD999",
      stripePaymentIntentId: "pi_existing",
      totalCents: 3000,
      currency: "usd",
      items: [orderItem({ variantId: "v1", quantity: 2 })],
    });
  }

  it("reuses a matching in-flight intent instead of minting a new one", async () => {
    getCartView.mockResolvedValue(cartView());
    findReusable.mockResolvedValue([reusableCandidate()]);
    paymentIntents.retrieve.mockResolvedValue({
      id: "pi_existing",
      status: "requires_payment_method",
      amount: 3000,
      currency: "usd",
      client_secret: "cs_existing",
    });

    const result = await orderService.startCheckout(
      TENANT,
      [{ variantId: "v1", qty: 2 }],
      EMAIL,
      SHIPPING,
      "usd",
      null,
    );

    expect(result).toEqual({
      clientSecret: "cs_existing",
      orderId: "order_existing",
      orderNumber: "20250101-OLD999",
      totalCents: 3000,
      currency: "usd",
    });
    // The whole point: no second PaymentIntent, no second order (nor its hold).
    expect(paymentIntents.create).not.toHaveBeenCalled();
    expect(createWithItems).not.toHaveBeenCalled();
  });

  it("refreshes the reused order's shipping address so the latest input wins (#135)", async () => {
    getCartView.mockResolvedValue(cartView());
    findReusable.mockResolvedValue([reusableCandidate()]);
    paymentIntents.retrieve.mockResolvedValue({
      id: "pi_existing",
      status: "requires_payment_method",
      amount: 3000,
      currency: "usd",
      client_secret: "cs_existing",
    });

    // The shopper edited their address on the re-submit (same cart, so it still
    // reuses the in-flight intent).
    const edited: ShippingAddress = {
      ...SHIPPING,
      line1: "999 New Address Rd",
    };
    const result = await orderService.startCheckout(
      TENANT,
      [{ variantId: "v1", qty: 2 }],
      EMAIL,
      edited,
      "usd",
      null,
    );

    expect(result.orderId).toBe("order_existing");
    // Nothing new is minted…
    expect(paymentIntents.create).not.toHaveBeenCalled();
    expect(createWithItems).not.toHaveBeenCalled();
    // …but the reused PENDING order's address is overwritten with the latest one,
    // tenant-scoped — so a re-submit that changed the address never ships stale.
    expect(updateShipAddr).toHaveBeenCalledWith(
      TENANT,
      "order_existing",
      edited,
    );
  });

  it("keys the dedupe read on the RE-PRICED cart total + currency, not a stored one", async () => {
    getCartView.mockResolvedValue(
      cartView({ totalCents: 4200, currency: "eur" }),
    );
    findReusable.mockResolvedValue([]);
    paymentIntents.create.mockResolvedValue({
      id: "pi_1",
      client_secret: "cs_1",
    });
    createWithItems.mockResolvedValue(order());

    await orderService.startCheckout(
      TENANT,
      [{ variantId: "v1", qty: 2 }],
      EMAIL,
      SHIPPING,
      "eur",
      null,
    );

    expect(findReusable).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        email: EMAIL,
        totalCents: 4200,
        currency: "eur",
        createdAfter: expect.any(Date),
        limit: expect.any(Number),
      }),
    );
    // The reuse window is a lower bound in the past.
    const { createdAfter } = findReusable.mock.calls[0][0];
    expect(createdAfter.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("binds an authenticated reuse to the session userId, never the typed email (#92)", async () => {
    getCartView.mockResolvedValue(cartView());
    findReusable.mockResolvedValue([]);
    paymentIntents.create.mockResolvedValue({
      id: "pi_1",
      client_secret: "cs_1",
    });
    createWithItems.mockResolvedValue(order());

    await orderService.startCheckout(
      TENANT,
      [{ variantId: "v1", qty: 2 }],
      EMAIL,
      SHIPPING,
      "usd",
      "user_alice",
    );

    // The dedupe read is keyed on the session-proven userId; the client-supplied
    // email is NOT part of an authenticated match, so it can't widen who an
    // in-flight intent may be handed back to (the crux of #92).
    const arg = findReusable.mock.calls[0][0];
    expect(arg).toMatchObject({ tenantId: TENANT, userId: "user_alice" });
    expect("email" in arg).toBe(false);
  });

  it("keeps a guest reuse email-keyed but pinned to userId:null (#92)", async () => {
    getCartView.mockResolvedValue(cartView());
    findReusable.mockResolvedValue([]);
    paymentIntents.create.mockResolvedValue({
      id: "pi_1",
      client_secret: "cs_1",
    });
    createWithItems.mockResolvedValue(order());

    await orderService.startCheckout(
      TENANT,
      [{ variantId: "v1", qty: 2 }],
      EMAIL,
      SHIPPING,
      "usd",
      null,
    );

    // A guest carries userId:null in the WHERE — the pin that stops a guest email
    // from matching a signed-in shopper's PENDING order — alongside the email.
    expect(findReusable).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, userId: null, email: EMAIL }),
    );
  });

  it("creates fresh when there is no candidate to reuse", async () => {
    getCartView.mockResolvedValue(cartView());
    findReusable.mockResolvedValue([]);
    paymentIntents.create.mockResolvedValue({
      id: "pi_1",
      client_secret: "cs_1",
    });
    createWithItems.mockResolvedValue(order());

    const result = await orderService.startCheckout(
      TENANT,
      [{ variantId: "v1", qty: 2 }],
      EMAIL,
      SHIPPING,
      "usd",
      null,
    );

    expect(paymentIntents.create).toHaveBeenCalledTimes(1);
    expect(createWithItems).toHaveBeenCalledTimes(1);
    expect(result.clientSecret).toBe("cs_1");
  });

  it("does not reuse a candidate whose line-set differs from the cart", async () => {
    getCartView.mockResolvedValue(cartView()); // cart is v1 × 2
    findReusable.mockResolvedValue([
      orderWithItems({
        stripePaymentIntentId: "pi_existing",
        items: [orderItem({ variantId: "v1", quantity: 3 })], // qty differs
      }),
    ]);
    paymentIntents.create.mockResolvedValue({
      id: "pi_1",
      client_secret: "cs_1",
    });
    createWithItems.mockResolvedValue(order());

    const result = await orderService.startCheckout(
      TENANT,
      [{ variantId: "v1", qty: 2 }],
      EMAIL,
      SHIPPING,
      "usd",
      null,
    );

    // A mismatch is rejected before any Stripe retrieve; checkout mints fresh.
    expect(paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(paymentIntents.create).toHaveBeenCalledTimes(1);
    expect(result.clientSecret).toBe("cs_1");
  });

  it("does not reuse a candidate whose intent is no longer awaiting payment", async () => {
    getCartView.mockResolvedValue(cartView());
    findReusable.mockResolvedValue([reusableCandidate()]);
    paymentIntents.retrieve.mockResolvedValue({
      id: "pi_existing",
      status: "succeeded", // already paid — never re-hand this out
      amount: 3000,
      currency: "usd",
      client_secret: "cs_existing",
    });
    paymentIntents.create.mockResolvedValue({
      id: "pi_1",
      client_secret: "cs_1",
    });
    createWithItems.mockResolvedValue(order());

    const result = await orderService.startCheckout(
      TENANT,
      [{ variantId: "v1", qty: 2 }],
      EMAIL,
      SHIPPING,
      "usd",
      null,
    );

    expect(paymentIntents.create).toHaveBeenCalledTimes(1);
    expect(result.clientSecret).toBe("cs_1");
  });

  it("does not reuse a candidate whose intent amount has drifted", async () => {
    getCartView.mockResolvedValue(cartView({ totalCents: 3000 }));
    findReusable.mockResolvedValue([reusableCandidate()]);
    paymentIntents.retrieve.mockResolvedValue({
      id: "pi_existing",
      status: "requires_payment_method",
      amount: 9999, // no longer equals the re-priced cart
      currency: "usd",
      client_secret: "cs_existing",
    });
    paymentIntents.create.mockResolvedValue({
      id: "pi_1",
      client_secret: "cs_1",
    });
    createWithItems.mockResolvedValue(order());

    const result = await orderService.startCheckout(
      TENANT,
      [{ variantId: "v1", qty: 2 }],
      EMAIL,
      SHIPPING,
      "usd",
      null,
    );

    expect(paymentIntents.create).toHaveBeenCalledTimes(1);
    expect(result.clientSecret).toBe("cs_1");
  });

  it("falls through to a fresh create when the intent can't be retrieved", async () => {
    getCartView.mockResolvedValue(cartView());
    findReusable.mockResolvedValue([reusableCandidate()]);
    paymentIntents.retrieve.mockRejectedValue(
      new Error("No such payment_intent"),
    );
    paymentIntents.create.mockResolvedValue({
      id: "pi_1",
      client_secret: "cs_1",
    });
    createWithItems.mockResolvedValue(order());

    const result = await orderService.startCheckout(
      TENANT,
      [{ variantId: "v1", qty: 2 }],
      EMAIL,
      SHIPPING,
      "usd",
      null,
    );

    expect(paymentIntents.create).toHaveBeenCalledTimes(1);
    expect(result.clientSecret).toBe("cs_1");
  });

  it("skips a non-matching candidate and reuses the matching one", async () => {
    getCartView.mockResolvedValue(cartView()); // v1 × 2
    findReusable.mockResolvedValue([
      // Newest first: this one doesn't match the cart, so it's skipped…
      orderWithItems({
        id: "order_other",
        stripePaymentIntentId: "pi_other",
        items: [orderItem({ variantId: "v2", quantity: 1 })],
      }),
      // …and this matching one is reused.
      reusableCandidate(),
    ]);
    paymentIntents.retrieve.mockResolvedValue({
      id: "pi_existing",
      status: "requires_confirmation",
      amount: 3000,
      currency: "usd",
      client_secret: "cs_existing",
    });

    const result = await orderService.startCheckout(
      TENANT,
      [{ variantId: "v1", qty: 2 }],
      EMAIL,
      SHIPPING,
      "usd",
      null,
    );

    expect(result.orderId).toBe("order_existing");
    // Only the matching candidate's intent is retrieved; the mismatch is filtered first.
    expect(paymentIntents.retrieve).toHaveBeenCalledTimes(1);
    expect(paymentIntents.retrieve).toHaveBeenCalledWith("pi_existing");
    expect(paymentIntents.create).not.toHaveBeenCalled();
  });
});

/**
 * Sweep abandoned PENDING checkouts (#25). The invariants under test: an order is
 * cancelled only once its intent is provably `canceled` (money-safety), a payment
 * in flight or captured is never touched, the DB flip's guard turns a lost race
 * into a skip, and one order's error can't abort the batch.
 */
describe("orderService.sweepAbandonedPending", () => {
  it("cancels the intent and releases an abandoned, still-chargeable order", async () => {
    findStale.mockResolvedValue([
      stalePending({ id: "o1", stripePaymentIntentId: "pi_1" }),
    ]);
    paymentIntents.retrieve.mockResolvedValue({
      id: "pi_1",
      status: "requires_payment_method",
    });
    paymentIntents.cancel.mockResolvedValue({ id: "pi_1", status: "canceled" });
    cancelRepo.mockResolvedValue({ transitioned: true });

    const result = await orderService.sweepAbandonedPending();

    expect(paymentIntents.cancel).toHaveBeenCalledWith("pi_1");
    expect(cancelRepo).toHaveBeenCalledWith(TENANT, "o1");
    expect(result).toEqual({ swept: 1, skipped: 0, errored: 0 });
  });

  it("queries stale orders with a past grace cutoff and a batch limit", async () => {
    findStale.mockResolvedValue([]);

    await orderService.sweepAbandonedPending();

    expect(findStale).toHaveBeenCalledTimes(1);
    const [olderThan, limit] = findStale.mock.calls[0];
    expect(olderThan).toBeInstanceOf(Date);
    expect(olderThan.getTime()).toBeLessThan(Date.now()); // grace window in the past
    expect(limit).toBeGreaterThan(0);
  });

  it("leaves a SUCCEEDED intent's order for the webhook (never cancels a paid order)", async () => {
    findStale.mockResolvedValue([
      stalePending({ id: "o1", stripePaymentIntentId: "pi_1" }),
    ]);
    paymentIntents.retrieve.mockResolvedValue({
      id: "pi_1",
      status: "succeeded",
    });

    const result = await orderService.sweepAbandonedPending();

    expect(paymentIntents.cancel).not.toHaveBeenCalled();
    expect(cancelRepo).not.toHaveBeenCalled();
    expect(result).toEqual({ swept: 0, skipped: 1, errored: 0 });
  });

  it("leaves an in-progress (processing) payment alone", async () => {
    findStale.mockResolvedValue([stalePending()]);
    paymentIntents.retrieve.mockResolvedValue({
      id: "pi_1",
      status: "processing",
    });

    const result = await orderService.sweepAbandonedPending();

    expect(paymentIntents.cancel).not.toHaveBeenCalled();
    expect(cancelRepo).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it("leaves a payment awaiting customer action (3DS) alone", async () => {
    findStale.mockResolvedValue([stalePending()]);
    paymentIntents.retrieve.mockResolvedValue({
      id: "pi_1",
      status: "requires_action",
    });

    const result = await orderService.sweepAbandonedPending();

    expect(paymentIntents.cancel).not.toHaveBeenCalled();
    expect(cancelRepo).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it("reconciles an already-canceled intent by flipping the order, without re-cancelling", async () => {
    findStale.mockResolvedValue([stalePending({ id: "o1" })]);
    paymentIntents.retrieve.mockResolvedValue({
      id: "pi_1",
      status: "canceled",
    });
    cancelRepo.mockResolvedValue({ transitioned: true });

    const result = await orderService.sweepAbandonedPending();

    expect(paymentIntents.cancel).not.toHaveBeenCalled();
    expect(cancelRepo).toHaveBeenCalledWith(TENANT, "o1");
    expect(result).toEqual({ swept: 1, skipped: 0, errored: 0 });
  });

  it("does NOT flip the order when the cancel loses the race to a real payment", async () => {
    findStale.mockResolvedValue([stalePending()]);
    paymentIntents.retrieve.mockResolvedValue({
      id: "pi_1",
      status: "requires_payment_method",
    });
    // Shopper paid in the retrieve→cancel window: cancel now throws.
    paymentIntents.cancel.mockRejectedValue(
      new Error("payment_intent_unexpected_state"),
    );

    const result = await orderService.sweepAbandonedPending();

    // The order stays PENDING for the webhook — money-safety over cleanup.
    expect(cancelRepo).not.toHaveBeenCalled();
    expect(result).toEqual({ swept: 0, skipped: 1, errored: 0 });
  });

  it("does NOT flip the order when the cancel returns a non-canceled status", async () => {
    findStale.mockResolvedValue([stalePending()]);
    paymentIntents.retrieve.mockResolvedValue({
      id: "pi_1",
      status: "requires_confirmation",
    });
    paymentIntents.cancel.mockResolvedValue({
      id: "pi_1",
      status: "processing",
    });

    const result = await orderService.sweepAbandonedPending();

    expect(cancelRepo).not.toHaveBeenCalled();
    expect(result.swept).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("cancels-and-releases an order with no linked intent (anomaly) via the DB guard", async () => {
    findStale.mockResolvedValue([
      stalePending({ id: "o1", stripePaymentIntentId: null }),
    ]);
    cancelRepo.mockResolvedValue({ transitioned: true });

    const result = await orderService.sweepAbandonedPending();

    expect(paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(cancelRepo).toHaveBeenCalledWith(TENANT, "o1");
    expect(result.swept).toBe(1);
  });

  it("counts a lost race to PAID (guard no-op) as skipped, not swept", async () => {
    findStale.mockResolvedValue([stalePending()]);
    paymentIntents.retrieve.mockResolvedValue({
      id: "pi_1",
      status: "requires_payment_method",
    });
    paymentIntents.cancel.mockResolvedValue({ id: "pi_1", status: "canceled" });
    // The webhook flipped it PENDING → PAID between retrieve and flip.
    cancelRepo.mockResolvedValue({
      transitioned: false,
      currentStatus: "PAID",
    });

    const result = await orderService.sweepAbandonedPending();

    expect(result).toEqual({ swept: 0, skipped: 1, errored: 0 });
  });

  it("isolates one order's error and keeps sweeping the rest", async () => {
    findStale.mockResolvedValue([
      stalePending({ id: "o1", stripePaymentIntentId: "pi_1" }),
      stalePending({ id: "o2", stripePaymentIntentId: "pi_2" }),
    ]);
    paymentIntents.retrieve.mockResolvedValue({
      id: "pi",
      status: "requires_payment_method",
    });
    paymentIntents.cancel.mockResolvedValue({ status: "canceled" });
    // First order's DB flip blows up; the second sweeps fine.
    cancelRepo
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({ transitioned: true });

    const result = await orderService.sweepAbandonedPending();

    expect(result).toEqual({ swept: 1, skipped: 0, errored: 1 });
  });

  it("is a clean no-op when nothing is stale", async () => {
    findStale.mockResolvedValue([]);

    const result = await orderService.sweepAbandonedPending();

    expect(result).toEqual({ swept: 0, skipped: 0, errored: 0 });
    expect(paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(paymentIntents.cancel).not.toHaveBeenCalled();
    expect(cancelRepo).not.toHaveBeenCalled();
  });
});
