import { describe, it, expect, beforeEach, vi } from "vitest";
import type Stripe from "stripe";
import type { Order, OrderItem } from "@prisma/client";
import { getStripe } from "@/lib/stripe";
import { orderService } from "@/server/services/order.service";
import { outboxService } from "@/server/services/outbox.service";
import { reportError } from "@/server/observability/error-reporter";
import { logger } from "@/server/observability/logger";
import {
  type OrderWithItems,
  type StockShortfall,
} from "@/server/repositories/order.repository";
import { POST } from "@/app/api/webhooks/stripe/route";

/**
 * Route test for the Stripe webhook — the app's authoritative "paid"/"refunded"
 * signal (#78). Signature verification, the order service, the outbox dispatch,
 * and the error reporter are all mocked, so this drives the route's *glue* — the
 * branching in `handlePaymentIntentSucceeded` and `handleRefundEvent` — without a
 * network, a database, or a real HMAC. `constructEvent` is mocked to hand back a
 * crafted event, so each test picks the branch by the event it returns and asserts
 * the branch's observable trio: the service call it makes (or doesn't), the
 * response status, and the log level (the only thing that separates two branches
 * that otherwise behave identically — e.g. a normal already-`REFUNDED` duplicate
 * from an anomalous refund on an un-captured order).
 *
 * The service layer's own state machine is covered in `order.service.test.ts` and
 * the repositories' integration suites; this is deliberately just the webhook seam.
 */

vi.mock("@/lib/stripe", () => {
  // One stable client stub so `getStripe().webhooks.constructEvent` is the same
  // spy every call (mirrors how the cron route tests grab a service singleton).
  const stripe = { webhooks: { constructEvent: vi.fn() } };
  return { getStripe: () => stripe };
});
vi.mock("@/server/services/order.service", () => ({
  orderService: { markOrderPaid: vi.fn(), markOrderRefunded: vi.fn() },
}));
vi.mock("@/server/services/outbox.service", () => ({
  outboxService: { dispatchForOrder: vi.fn() },
}));
vi.mock("@/server/observability/error-reporter", () => ({
  reportError: vi.fn(),
}));
// Self-returning child stub with spy levels, so we can assert the log-level
// mapping. `child` is a plain arrow (untouched by resetAllMocks); the levels are
// spies (reset between tests). Every `.child()` returns the same object, so the
// spies we assert on are exactly the ones the handler calls through `eventLog`.
vi.mock("@/server/observability/logger", () => {
  const stub = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => stub,
  };
  return { logger: stub };
});

const constructEvent = vi.mocked(getStripe().webhooks.constructEvent);
const markPaid = vi.mocked(orderService.markOrderPaid);
const markRefunded = vi.mocked(orderService.markOrderRefunded);
const dispatch = vi.mocked(outboxService.dispatchForOrder);
const report = vi.mocked(reportError);
const logInfo = vi.mocked(logger.info);
const logWarn = vi.mocked(logger.warn);
const logError = vi.mocked(logger.error);

const TENANT = "tenant_1";

// --- Fixtures ---------------------------------------------------------------
// Prisma-typed order fixtures (mirrors order.service.test.ts) so the `"paid"`
// result typechecks against the real `OrderWithItems`.

function order(o: Partial<Order> = {}): Order {
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

function shortfall(o: Partial<StockShortfall> = {}): StockShortfall {
  return {
    variantId: "v1",
    titleSnapshot: "Tee — Blue",
    ordered: 3,
    available: 1,
    ...o,
  };
}

// Stripe's `Event`, `PaymentIntent`, and `Refund` are large SDK unions, and the
// route reads only a handful of fields off each; a minimal envelope plus a cast
// keeps fixtures legible (mirrors `e2e/support/stripe.ts`, which builds the same
// minimal event around a real intent).

/** Wrap a data object in the minimal event envelope the route reads
 *  (`event.id`, `event.type`, `event.data.object`). */
function stripeEvent(type: string, object: unknown): Stripe.Event {
  return {
    id: "evt_test_123",
    object: "event",
    api_version: "2025-01-27.acacia",
    created: 1_700_000_000,
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
    data: { object },
  } as unknown as Stripe.Event;
}

function paymentIntent(o: {
  id?: string;
  tenantId?: string | null;
}): Stripe.PaymentIntent {
  const metadata: Record<string, string> = {};
  if (o.tenantId) metadata.tenantId = o.tenantId;
  return {
    id: o.id ?? "pi_1",
    object: "payment_intent",
    metadata,
  } as unknown as Stripe.PaymentIntent;
}

function refund(o: {
  id?: string;
  status: string;
  tenantId?: string | null;
  orderId?: string | null;
  // Omitted → a string id (the webhook default); pass `null` to force the
  // no-payment_intent branch, or `{ id }` to exercise the expand-normalization.
  paymentIntent?: string | { id: string } | null;
  failureReason?: string;
}): Stripe.Refund {
  const metadata: Record<string, string> = {};
  if (o.tenantId) metadata.tenantId = o.tenantId;
  if (o.orderId) metadata.orderId = o.orderId;
  return {
    id: o.id ?? "re_1",
    object: "refund",
    status: o.status,
    payment_intent: o.paymentIntent === undefined ? "pi_1" : o.paymentIntent,
    failure_reason: o.failureReason,
    metadata,
  } as unknown as Stripe.Refund;
}

/** A POST at the webhook, with a raw body and (by default) a signature header.
 *  Body/signature content is irrelevant — `constructEvent` is mocked. */
function webhookRequest(signature: string | null = "sig_test"): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) headers.set("stripe-signature", signature);
  return new Request("https://example.test/api/webhooks/stripe", {
    method: "POST",
    headers,
    body: "{}",
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  dispatch.mockResolvedValue(undefined);
});

describe("POST /api/webhooks/stripe — request & signature contract", () => {
  it("400s a request with no stripe-signature header, without verifying", async () => {
    const response = await POST(webhookRequest(null));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Missing signature" });
    expect(constructEvent).not.toHaveBeenCalled();
  });

  it("400s and logs (never reports) when signature verification fails", async () => {
    constructEvent.mockImplementation(() => {
      throw new Error("bad signature");
    });

    const response = await POST(webhookRequest("forged"));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Invalid signature" });
    expect(logError).toHaveBeenCalledTimes(1);
    // A routine 400 (probe / stale secret) is a log, not an alert.
    expect(report).not.toHaveBeenCalled();
    expect(markPaid).not.toHaveBeenCalled();
    expect(markRefunded).not.toHaveBeenCalled();
  });

  it("200s and ignores a verified event type it doesn't handle", async () => {
    constructEvent.mockReturnValue(stripeEvent("charge.updated", {}));

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ received: true });
    expect(markPaid).not.toHaveBeenCalled();
    expect(markRefunded).not.toHaveBeenCalled();
  });

  it("500s and reports when a handler throws, so Stripe retries", async () => {
    constructEvent.mockReturnValue(
      stripeEvent(
        "payment_intent.succeeded",
        paymentIntent({ id: "pi_1", tenantId: TENANT }),
      ),
    );
    markPaid.mockRejectedValue(new Error("database is down"));

    const response = await POST(webhookRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "Handler error" });
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        component: "stripe-webhook",
        eventType: "payment_intent.succeeded",
      }),
    );
  });
});

describe("payment_intent.succeeded → handlePaymentIntentSucceeded", () => {
  function paidEvent(tenantId: string | null = TENANT): Stripe.Event {
    return stripeEvent(
      "payment_intent.succeeded",
      paymentIntent({ id: "pi_1", tenantId }),
    );
  }

  it("marks the order PAID and dispatches the confirmation email", async () => {
    constructEvent.mockReturnValue(paidEvent());
    markPaid.mockResolvedValue({
      outcome: "paid",
      order: orderWithItems({ id: "order_1", orderNumber: "20250101-AAA111" }),
      shortfalls: [],
    });

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(markPaid).toHaveBeenCalledWith(TENANT, "pi_1");
    expect(dispatch).toHaveBeenCalledWith(TENANT, "order_1");
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalled();
  });

  it("also alerts (error) on an oversell shortfall, still 200 and dispatches", async () => {
    constructEvent.mockReturnValue(paidEvent());
    markPaid.mockResolvedValue({
      outcome: "paid",
      order: orderWithItems({ id: "order_1" }),
      shortfalls: [shortfall()],
    });

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    // The PAID info line still fires — the OVERSELL alert is *in addition to*
    // it (route.ts logs both), not instead of it.
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledTimes(1); // OVERSELL alert
    expect(dispatch).toHaveBeenCalledWith(TENANT, "order_1");
  });

  it("no-ops a duplicate (already-processed) without dispatching", async () => {
    constructEvent.mockReturnValue(paidEvent());
    markPaid.mockResolvedValue({ outcome: "already-processed" });

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(markPaid).toHaveBeenCalledWith(TENANT, "pi_1");
    expect(dispatch).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("warns on a paid intent with no matching order, without dispatching", async () => {
    constructEvent.mockReturnValue(paidEvent());
    markPaid.mockResolvedValue({ outcome: "no-order" });

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(dispatch).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logInfo).not.toHaveBeenCalled();
  });

  it("ignores an intent with no tenantId metadata (not ours to act on)", async () => {
    constructEvent.mockReturnValue(paidEvent(null));

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(markPaid).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledTimes(1);
  });
});

describe("refund.* → handleRefundEvent", () => {
  it("ignores a dashboard-initiated refund with no tenantId metadata", async () => {
    constructEvent.mockReturnValue(
      stripeEvent(
        "refund.updated",
        refund({ status: "succeeded", tenantId: null }),
      ),
    );

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(markRefunded).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it("alerts (error) on a failed refund without touching the DB", async () => {
    constructEvent.mockReturnValue(
      stripeEvent(
        "refund.failed",
        refund({
          status: "failed",
          tenantId: TENANT,
          orderId: "order_1",
          failureReason: "declined",
        }),
      ),
    );

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(markRefunded).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledTimes(1);
    // Error-only: a failed refund is an alert, not an info/warn no-op.
    expect(logInfo).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("branches on refund.status, not the event name (refund.created + status=failed still alerts)", async () => {
    // The route deliberately switches on `refund.status`, not the event name —
    // all three refund.* types funnel through one handler (route.ts:261-265).
    // Pin it: a `refund.created` whose status is `failed` must take the failed
    // (alert-only) branch, which a refactor keying off the event name would miss.
    constructEvent.mockReturnValue(
      stripeEvent(
        "refund.created",
        refund({
          status: "failed",
          tenantId: TENANT,
          orderId: "order_1",
          failureReason: "declined",
        }),
      ),
    );

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(markRefunded).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it.each(["pending", "requires_action", "canceled"])(
    "no-ops an interim '%s' refund (info, no DB write)",
    async (status) => {
      constructEvent.mockReturnValue(
        stripeEvent("refund.updated", refund({ status, tenantId: TENANT })),
      );

      const response = await POST(webhookRequest());

      expect(response.status).toBe(200);
      expect(markRefunded).not.toHaveBeenCalled();
      expect(logInfo).toHaveBeenCalledTimes(1);
      expect(logError).not.toHaveBeenCalled();
    },
  );

  it("warns when a succeeded refund has no payment_intent to key on", async () => {
    constructEvent.mockReturnValue(
      stripeEvent(
        "refund.updated",
        refund({ status: "succeeded", tenantId: TENANT, paymentIntent: null }),
      ),
    );

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(markRefunded).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it("marks the order REFUNDED on a succeeded refund (string payment_intent)", async () => {
    constructEvent.mockReturnValue(
      stripeEvent(
        "refund.created",
        refund({
          status: "succeeded",
          tenantId: TENANT,
          orderId: "order_1",
          paymentIntent: "pi_1",
        }),
      ),
    );
    markRefunded.mockResolvedValue({ outcome: "refunded" });

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(markRefunded).toHaveBeenCalledWith(TENANT, "pi_1");
    expect(logInfo).toHaveBeenCalledTimes(1);
  });

  it("normalizes an expanded payment_intent object to its id", async () => {
    constructEvent.mockReturnValue(
      stripeEvent(
        "refund.updated",
        refund({
          status: "succeeded",
          tenantId: TENANT,
          paymentIntent: { id: "pi_99" },
        }),
      ),
    );
    markRefunded.mockResolvedValue({ outcome: "refunded" });

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(markRefunded).toHaveBeenCalledWith(TENANT, "pi_99");
  });

  it("no-ops (info) a duplicate refund whose order is already REFUNDED", async () => {
    constructEvent.mockReturnValue(
      stripeEvent(
        "refund.updated",
        refund({
          status: "succeeded",
          tenantId: TENANT,
          paymentIntent: "pi_1",
        }),
      ),
    );
    markRefunded.mockResolvedValue({
      outcome: "already-processed",
      currentStatus: "REFUNDED",
    });

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("warns on a succeeded refund for an order not in a refundable state", async () => {
    constructEvent.mockReturnValue(
      stripeEvent(
        "refund.updated",
        refund({
          status: "succeeded",
          tenantId: TENANT,
          paymentIntent: "pi_1",
        }),
      ),
    );
    markRefunded.mockResolvedValue({
      outcome: "already-processed",
      currentStatus: "PENDING",
    });

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logInfo).not.toHaveBeenCalled();
  });

  it("warns when no order matches the refunded payment_intent", async () => {
    constructEvent.mockReturnValue(
      stripeEvent(
        "refund.updated",
        refund({
          status: "succeeded",
          tenantId: TENANT,
          paymentIntent: "pi_1",
        }),
      ),
    );
    markRefunded.mockResolvedValue({ outcome: "no-order" });

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(logWarn).toHaveBeenCalledTimes(1);
  });
});
