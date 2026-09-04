import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { OrderItem } from "@prisma/client";
import { outboxService } from "@/server/services/outbox.service";
import { outboxRepository } from "@/server/repositories/outbox.repository";
import type { OutboxMessageSummary } from "@/server/repositories/outbox.repository";
import { orderRepository } from "@/server/repositories/order.repository";
import { emailService } from "@/server/services/email.service";
import { fulfillmentService } from "@/server/services/fulfillment.service";
import {
  EmailNotConfiguredError,
  EmailSendTimeoutError,
} from "@/server/email.errors";
import {
  FulfillmentNotConfiguredError,
  FulfillmentNotMappedError,
  FulfillmentRejectedError,
} from "@/server/fulfillment.errors";
import { reportError } from "@/server/observability/error-reporter";
import type { OrderWithItems } from "@/server/repositories/order.repository";

/**
 * Unit tests for the outbox drain, with the repositories, the email service, and
 * the error reporter mocked. The focus is the state machine each message walks —
 * claim → send → SENT / reschedule-with-backoff / DEAD — and the severity policy
 * (a permanent failure dies at once and, unless it's just an unconfigured store,
 * alerts). The atomic-claim guarantee itself lives in the database, so it is
 * covered by `outbox.repository.integration.test.ts`, not here.
 */

vi.mock("@/server/repositories/outbox.repository", () => ({
  outboxRepository: {
    recoverStaleClaims: vi.fn(),
    findDue: vi.fn(),
    findDueForOrder: vi.fn(),
    claim: vi.fn(),
    markSent: vi.fn(),
    reschedule: vi.fn(),
    markDead: vi.fn(),
    defer: vi.fn(),
  },
}));
vi.mock("@/server/repositories/order.repository", () => ({
  orderRepository: { findByIdForTenant: vi.fn() },
}));
vi.mock("@/server/services/email.service", () => ({
  emailService: { sendOrderConfirmation: vi.fn() },
}));
vi.mock("@/server/services/fulfillment.service", () => ({
  fulfillmentService: { submitOrder: vi.fn() },
}));
vi.mock("@/server/observability/error-reporter", () => ({
  reportError: vi.fn(),
}));
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

const recoverStaleClaims = vi.mocked(outboxRepository.recoverStaleClaims);
const findDue = vi.mocked(outboxRepository.findDue);
const findDueForOrder = vi.mocked(outboxRepository.findDueForOrder);
const claim = vi.mocked(outboxRepository.claim);
const markSent = vi.mocked(outboxRepository.markSent);
const reschedule = vi.mocked(outboxRepository.reschedule);
const markDead = vi.mocked(outboxRepository.markDead);
const defer = vi.mocked(outboxRepository.defer);
const findOrder = vi.mocked(orderRepository.findByIdForTenant);
const sendOrderConfirmation = vi.mocked(emailService.sendOrderConfirmation);
const submitOrder = vi.mocked(fulfillmentService.submitOrder);
const report = vi.mocked(reportError);

// Frozen clock so `new Date()` / `Date.now()` in the service are deterministic —
// the backoff schedule and the stale-claim cutoff are computed from them.
const NOW = new Date("2026-01-15T12:00:00.000Z");
const CLAIM_TIMEOUT_MS = 5 * 60_000;
const BACKOFF_FIRST_MS = 60_000;
const DEFER_MS = 60 * 60_000;

function summary(o: Partial<OutboxMessageSummary> = {}): OutboxMessageSummary {
  return {
    id: "msg_1",
    tenantId: "tenant_1",
    type: "ORDER_CONFIRMATION",
    orderId: "order_1",
    idempotencyKey: "oc_order_1",
    attempts: 0,
    ...o,
  };
}

function orderItem(o: Partial<OrderItem> = {}): OrderItem {
  return {
    id: "item_1",
    orderId: "order_1",
    variantId: "v1",
    titleSnapshot: "Widget",
    priceCents: 2500,
    quantity: 1,
    ...o,
  };
}

function orderWithItems(o: Partial<OrderWithItems> = {}): OrderWithItems {
  return {
    id: "order_1",
    tenantId: "tenant_1",
    orderNumber: "20260115-ABCDEF",
    status: "PAID",
    email: "shopper@example.com",
    userId: null,
    totalCents: 2500,
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
    createdAt: NOW,
    updatedAt: NOW,
    items: [orderItem()],
    ...o,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.resetAllMocks();
  // Happy-path defaults; individual tests override.
  recoverStaleClaims.mockResolvedValue(0);
  findDue.mockResolvedValue([]);
  findDueForOrder.mockResolvedValue([]);
  claim.mockResolvedValue(true);
  markSent.mockResolvedValue(undefined);
  reschedule.mockResolvedValue(undefined);
  markDead.mockResolvedValue(undefined);
  defer.mockResolvedValue(undefined);
  findOrder.mockResolvedValue(orderWithItems());
  sendOrderConfirmation.mockResolvedValue(undefined);
  submitOrder.mockResolvedValue(undefined);
  report.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("outboxService.drain", () => {
  it("recovers stale claims with a cutoff one claim-timeout behind now", async () => {
    recoverStaleClaims.mockResolvedValue(3);

    const result = await outboxService.drain();

    expect(recoverStaleClaims).toHaveBeenCalledWith(
      new Date(NOW.getTime() - CLAIM_TIMEOUT_MS),
    );
    expect(result.recovered).toBe(3);
  });

  it("sends a due message and marks it SENT, forwarding the idempotency key", async () => {
    findDue.mockResolvedValue([summary()]);

    const result = await outboxService.drain();

    expect(claim).toHaveBeenCalledWith("msg_1", NOW);
    expect(findOrder).toHaveBeenCalledWith("tenant_1", "order_1");
    expect(sendOrderConfirmation).toHaveBeenCalledWith(orderWithItems(), {
      idempotencyKey: "oc_order_1",
    });
    expect(markSent).toHaveBeenCalledWith("msg_1");
    expect(result).toMatchObject({ sent: 1, failed: 0, dead: 0, skipped: 0 });
  });

  it("skips a message it loses the claim race for — no send", async () => {
    findDue.mockResolvedValue([summary()]);
    claim.mockResolvedValue(false);

    const result = await outboxService.drain();

    expect(sendOrderConfirmation).not.toHaveBeenCalled();
    expect(markSent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: 1, sent: 0 });
  });

  it("reschedules a transient failure with exponential backoff, no alert", async () => {
    findDue.mockResolvedValue([summary({ attempts: 0 })]);
    sendOrderConfirmation.mockRejectedValue(new Error("Resend 503"));

    const result = await outboxService.drain();

    expect(reschedule).toHaveBeenCalledWith(
      "msg_1",
      new Date(NOW.getTime() + BACKOFF_FIRST_MS),
      "Error: Resend 503",
    );
    expect(markDead).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    expect(result).toMatchObject({ failed: 1, dead: 0 });
  });

  it("treats a timed-out send (#31) as transient — reschedules, never DEAD", async () => {
    // The webhook bounds each Resend send (#31) and throws EmailSendTimeoutError
    // on a hung one. It must classify like any transient fault — backoff-and-retry,
    // not DEAD — so a slow Resend can't strand a paid order's confirmation, and the
    // webhook's 2xx is never at stake.
    findDue.mockResolvedValue([summary({ attempts: 0 })]);
    sendOrderConfirmation.mockRejectedValue(new EmailSendTimeoutError(5000));

    const result = await outboxService.drain();

    expect(reschedule).toHaveBeenCalledWith(
      "msg_1",
      new Date(NOW.getTime() + BACKOFF_FIRST_MS),
      expect.stringContaining("EmailSendTimeoutError"),
    );
    expect(markDead).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    expect(result).toMatchObject({ failed: 1, dead: 0 });
  });

  it("marks a message DEAD and alerts once the attempt budget is spent", async () => {
    // attempts=9 → this is the 10th (final) attempt.
    findDue.mockResolvedValue([summary({ attempts: 9 })]);
    sendOrderConfirmation.mockRejectedValue(new Error("Resend still down"));

    const result = await outboxService.drain();

    expect(markDead).toHaveBeenCalledWith("msg_1", "Error: Resend still down");
    expect(reschedule).not.toHaveBeenCalled();
    // A paid order left unconfirmed after the full retry window must be loud.
    expect(report).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ dead: 1, failed: 0 });
  });

  it("marks DEAD without alerting when email is simply not configured", async () => {
    findDue.mockResolvedValue([summary({ attempts: 0 })]);
    sendOrderConfirmation.mockRejectedValue(new EmailNotConfiguredError());

    const result = await outboxService.drain();

    // Permanent: dies on the first attempt rather than burning retries...
    expect(markDead).toHaveBeenCalledOnce();
    expect(reschedule).not.toHaveBeenCalled();
    // ...but an unconfigured store is expected, not an incident — no alert.
    expect(report).not.toHaveBeenCalled();
    expect(result).toMatchObject({ dead: 1 });
  });

  it("marks DEAD and alerts when the referenced order is gone (permanent)", async () => {
    findDue.mockResolvedValue([summary({ attempts: 0 })]);
    findOrder.mockResolvedValue(null);

    const result = await outboxService.drain();

    expect(sendOrderConfirmation).not.toHaveBeenCalled();
    expect(markDead).toHaveBeenCalledOnce();
    expect(reschedule).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledOnce(); // a data-integrity anomaly, alert
    expect(result).toMatchObject({ dead: 1 });
  });

  it("isolates a per-message DB error so the rest of the batch still drains", async () => {
    findDue.mockResolvedValue([
      summary({ id: "msg_bad", orderId: "order_bad" }),
      summary({ id: "msg_ok", orderId: "order_ok", idempotencyKey: "oc_ok" }),
    ]);
    // The first message's claim throws (a DB blip); the second must still send.
    claim.mockImplementation(async (id: string) => {
      if (id === "msg_bad") throw new Error("connection reset");
      return true;
    });

    const result = await outboxService.drain();

    expect(markSent).toHaveBeenCalledWith("msg_ok");
    expect(markSent).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ sent: 1 });
  });

  it("leaves a message for recovery if markSent fails after a successful send", async () => {
    // The crash window the Resend idempotency key exists for: the email is sent,
    // but recording it fails (a killed worker / DB blip).
    findDue.mockResolvedValue([summary()]);
    markSent.mockRejectedValue(new Error("connection reset after send"));

    const result = await outboxService.drain();

    // The drain must not crash, and must NOT treat this as a send failure: the
    // row is left SENDING (untouched by reschedule/markDead) for stale-claim
    // recovery to re-drain, where the idempotency key makes the re-send a no-op.
    expect(sendOrderConfirmation).toHaveBeenCalledOnce();
    expect(reschedule).not.toHaveBeenCalled();
    expect(markDead).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: 0, failed: 0, dead: 0 });
  });

  it("stops claiming once the per-run time budget is exceeded", async () => {
    findDue.mockResolvedValue([
      summary({ id: "msg_1", idempotencyKey: "oc_1" }),
      summary({ id: "msg_2", idempotencyKey: "oc_2" }),
    ]);
    // Handling the first message pushes the clock past the 45s budget, so the
    // loop must break before touching the second — deferring it to the next run.
    claim.mockImplementation(async (id: string) => {
      if (id === "msg_1") vi.setSystemTime(new Date(NOW.getTime() + 46_000));
      return true;
    });

    const result = await outboxService.drain();

    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith("msg_1", expect.any(Date));
    expect(result).toMatchObject({ sent: 1 });
  });
});

describe("outboxService.drain — FULFILLMENT_SUBMISSION (M4 #139)", () => {
  const fulfillmentMsg = (o: Partial<OutboxMessageSummary> = {}) =>
    summary({
      type: "FULFILLMENT_SUBMISSION",
      idempotencyKey: "fs_order_1",
      ...o,
    });

  it("dispatches to the fulfillment service and marks SENT on success", async () => {
    findDue.mockResolvedValue([fulfillmentMsg()]);

    const result = await outboxService.drain();

    expect(claim).toHaveBeenCalledWith("msg_1", NOW);
    expect(submitOrder).toHaveBeenCalledWith("tenant_1", "order_1");
    // This type has its own send path — the confirmation email is not touched, and
    // the service re-reads the order itself (no order re-read in the drain).
    expect(sendOrderConfirmation).not.toHaveBeenCalled();
    expect(findOrder).not.toHaveBeenCalled();
    expect(markSent).toHaveBeenCalledWith("msg_1");
    expect(result).toMatchObject({ sent: 1, failed: 0, dead: 0 });
  });

  it("marks DEAD and alerts on an unmapped variant (permanent)", async () => {
    findDue.mockResolvedValue([fulfillmentMsg({ attempts: 0 })]);
    submitOrder.mockRejectedValue(new FulfillmentNotMappedError(["HOOD-M"]));

    const result = await outboxService.drain();

    // A typed FulfillmentError is permanent: dies on the first attempt...
    expect(markDead).toHaveBeenCalledOnce();
    expect(reschedule).not.toHaveBeenCalled();
    // ...and an unmapped variant is a real incident an operator must fix — alert.
    expect(report).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ dead: 1, failed: 0 });
  });

  it("marks DEAD and alerts on a provider soft-rejection (permanent)", async () => {
    findDue.mockResolvedValue([fulfillmentMsg({ attempts: 0 })]);
    submitOrder.mockRejectedValue(
      new FulfillmentRejectedError("order_1", "printful"),
    );

    const result = await outboxService.drain();

    expect(markDead).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ dead: 1 });
  });

  it("marks DEAD WITHOUT alerting when fulfillment is simply not configured", async () => {
    findDue.mockResolvedValue([fulfillmentMsg({ attempts: 0 })]);
    submitOrder.mockRejectedValue(new FulfillmentNotConfiguredError());

    const result = await outboxService.drain();

    // Permanent, but an unconfigured provider is an expected setup state, not an
    // incident — mirrors EmailNotConfiguredError: DEAD, no alert.
    expect(markDead).toHaveBeenCalledOnce();
    expect(reschedule).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    expect(result).toMatchObject({ dead: 1 });
  });

  it("reschedules a transient provider fault (retry, never DEAD)", async () => {
    // A plain Error (a 5xx/timeout the adapter throws) is NOT a FulfillmentError,
    // so it is transient — backoff-and-retry, exactly like a Resend blip.
    findDue.mockResolvedValue([fulfillmentMsg({ attempts: 0 })]);
    submitOrder.mockRejectedValue(new Error("Printful 503"));

    const result = await outboxService.drain();

    expect(reschedule).toHaveBeenCalledWith(
      "msg_1",
      new Date(NOW.getTime() + BACKOFF_FIRST_MS),
      "Error: Printful 503",
    );
    expect(markDead).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    expect(result).toMatchObject({ failed: 1, dead: 0 });
  });
});

describe("outboxService.drain — SHIPPING_CONFIRMATION (M4 #140; send path is #141)", () => {
  const shippingMsg = (o: Partial<OutboxMessageSummary> = {}) =>
    summary({
      type: "SHIPPING_CONFIRMATION",
      idempotencyKey: "sc_order_1",
      ...o,
    });

  it("defers the message instead of sending, failing, or dead-lettering it", async () => {
    findDue.mockResolvedValue([shippingMsg({ attempts: 0 })]);

    const result = await outboxService.drain();

    // #140 enqueues these before the send path exists (#141): the drain must HOLD
    // the row (PENDING, pushed out) rather than dead-letter it — dead-lettering
    // would permanently drop a real shipping email and false-alarm on the happy path.
    expect(defer).toHaveBeenCalledWith(
      "msg_1",
      new Date(NOW.getTime() + DEFER_MS),
    );
    expect(markDead).not.toHaveBeenCalled();
    expect(reschedule).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    // Neither the confirmation nor the fulfillment send path is touched.
    expect(sendOrderConfirmation).not.toHaveBeenCalled();
    expect(submitOrder).not.toHaveBeenCalled();
    // A deferral is benign — counted as skipped, not sent/failed/dead.
    expect(result).toMatchObject({ sent: 0, failed: 0, dead: 0, skipped: 1 });
  });

  it("never dead-letters a deferral, even at a high attempt count", async () => {
    // A deferral counts no attempt (`defer` leaves `attempts` untouched), so a
    // SHIPPING_CONFIRMATION row can never march toward the DEAD budget while its
    // send path is still pending — it simply waits.
    findDue.mockResolvedValue([shippingMsg({ attempts: 9 })]);

    const result = await outboxService.drain();

    expect(defer).toHaveBeenCalledOnce();
    expect(markDead).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    expect(result).toMatchObject({ dead: 0, skipped: 1 });
  });
});

describe("outboxService.dispatchForOrder", () => {
  it("dispatches an order's due message (immediate best-effort send)", async () => {
    findDueForOrder.mockResolvedValue([summary()]);

    await outboxService.dispatchForOrder("tenant_1", "order_1");

    expect(findDueForOrder).toHaveBeenCalledWith("tenant_1", "order_1", NOW);
    expect(sendOrderConfirmation).toHaveBeenCalledOnce();
    expect(markSent).toHaveBeenCalledWith("msg_1");
  });

  it("never throws — a failure here must not disturb the webhook", async () => {
    findDueForOrder.mockRejectedValue(new Error("db down"));

    await expect(
      outboxService.dispatchForOrder("tenant_1", "order_1"),
    ).resolves.toBeUndefined();
  });
});
