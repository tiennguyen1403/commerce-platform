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
    cancelPendingAndRelease: vi.fn(),
    markFulfilled: vi.fn(),
    markRefundedByPaymentIntent: vi.fn(),
  },
}));

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
const cancelRepo = vi.mocked(orderRepository.cancelPendingAndRelease);
const fulfillRepo = vi.mocked(orderRepository.markFulfilled);
const markRefunded = vi.mocked(orderRepository.markRefundedByPaymentIntent);

const TENANT = "tenant_1";
const EMAIL = "shopper@example.com";
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
    totalCents: 3000,
    currency: "usd",
    stripePaymentIntentId: "pi_1",
    oversold: false,
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

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getStripe).mockReturnValue(fakeStripe);
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
      "usd",
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
      "usd",
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
        "usd",
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
        "usd",
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
        "usd",
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
      orderService.startCheckout(TENANT, [], EMAIL, "usd"),
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
        "usd",
      ),
    ).rejects.toThrow("Stripe did not return a client secret");
    expect(paymentIntents.cancel).toHaveBeenCalledWith("pi_2");
    expect(createWithItems).not.toHaveBeenCalled();
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
  it("delegates to the repository and resolves on a successful transition", async () => {
    cancelRepo.mockResolvedValue({ transitioned: true });

    await expect(
      orderService.cancelOrder(TENANT, "order_1"),
    ).resolves.toBeUndefined();
    expect(cancelRepo).toHaveBeenCalledWith(TENANT, "order_1");
  });

  it("throws OrderNotFoundError when the order doesn't exist", async () => {
    cancelRepo.mockResolvedValue({ transitioned: false, currentStatus: null });

    await expect(
      orderService.cancelOrder(TENANT, "order_x"),
    ).rejects.toBeInstanceOf(OrderNotFoundError);
  });

  it("throws OrderTransitionError naming the current status when it isn't PENDING", async () => {
    cancelRepo.mockResolvedValue({
      transitioned: false,
      currentStatus: "PAID",
    });

    await expect(
      orderService.cancelOrder(TENANT, "order_1"),
    ).rejects.toBeInstanceOf(OrderTransitionError);
    // The refusal message names the blocking status so the admin sees why.
    await expect(orderService.cancelOrder(TENANT, "order_1")).rejects.toThrow(
      /paid/i,
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
