import { afterAll, afterEach, describe, expect, it } from "vitest";
import { fulfillmentService } from "@/server/services/fulfillment.service";
import { MOCK_TERMINAL_FAIL_MARKER } from "@/server/fulfillment";
import { MOCK_ONHOLD_MARKER } from "@/server/fulfillment/mock";
import {
  createTestTenant,
  deleteTenantDeep,
  prisma,
  uniqueId,
} from "@/test/integration-db";

/**
 * Integration test for `fulfillmentService.pollOpenShipments` — the poll-fulfillment
 * cron's reconcile, end-to-end against a real Postgres and the real (deterministic)
 * mock provider. The mock is the provider the selector returns in test/CI
 * (no `PRINTFUL_API_KEY`, non-production), and its `getTracking` progresses
 * "submitted" → "shipped" over successive polls — so this exercises the whole
 * pull-and-reconcile loop the way the cron will: the guarded PAID → FULFILLED flip,
 * the tracking write, the shipping-confirmation enqueue, and idempotency under a
 * repeated poll. The DB-level guarantees of the flip itself are proven directly in
 * `order.repository.integration.test.ts`; here we prove the service wires the real
 * provider to them.
 *
 * `pollOpenShipments` is platform-wide (it spans tenants), so every assertion is
 * scoped to the one order this test creates — never an aggregate count.
 */

const tenantIds: string[] = [];
async function freshTenant() {
  const tenant = await createTestTenant();
  tenantIds.push(tenant.id);
  return tenant;
}

afterEach(async () => {
  await Promise.all(tenantIds.splice(0).map(deleteTenantDeep));
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Seed a SUBMITTED + PAID order carrying a provider order id — the poll's
 *  reconcilable state. A unique `externalId` keeps the mock's per-id poll counter
 *  fresh, so the "submitted → shipped" progression is deterministic per test. An
 *  optional `createdAt` (M4 #155) backdates the order past the stuck-age
 *  threshold — Prisma allows passing it explicitly on `.create()` despite the
 *  column's `@default(now())`; omitted, it defaults to now (a normally-
 *  progressing order, nowhere near the threshold). */
async function seedSubmittedOrder(
  tenantId: string,
  externalId: string,
  opts: { createdAt?: Date } = {},
) {
  return prisma.order.create({
    data: {
      tenantId,
      orderNumber: uniqueId("order"),
      status: "PAID",
      email: "shopper@example.com",
      totalCents: 1000,
      currency: "usd",
      stripePaymentIntentId: uniqueId("pi"),
      fulfillmentProvider: "mock",
      fulfillmentExternalId: externalId,
      fulfillmentStatus: "SUBMITTED",
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
}

describe("fulfillmentService.pollOpenShipments (integration, mock provider)", () => {
  it("reconciles a mock shipment over two polls, idempotently", async () => {
    const tenant = await freshTenant();
    const externalId = uniqueId("mock");
    const order = await seedSubmittedOrder(tenant.id, externalId);

    // Poll 1: the mock reports "submitted" (no tracking) — the order is left
    // SUBMITTED and nothing is enqueued (a not-shipped poll is a pure no-op).
    await fulfillmentService.pollOpenShipments();
    let persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.status).toBe("PAID");
    expect(persisted.fulfillmentStatus).toBe("SUBMITTED");
    expect(
      await prisma.outboxMessage.count({ where: { orderId: order.id } }),
    ).toBe(0);

    // Poll 2: the mock now reports "shipped" with a carrier + tracking — reconcile
    // to FULFILLED, persist the tracking, and enqueue exactly one shipping email.
    await fulfillmentService.pollOpenShipments();
    persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.status).toBe("FULFILLED");
    expect(persisted.fulfillmentStatus).toBe("SHIPPED");
    expect(persisted.fulfillmentProviderStatus).toBe("shipped");
    expect(persisted.trackingCarrier).toBe("Mock Carrier");
    expect(persisted.trackingNumber).toBe(`MOCK-${externalId}`);
    expect(persisted.trackingUrl).toBe(
      `https://tracking.example.test/${externalId}`,
    );

    const messages = await prisma.outboxMessage.findMany({
      where: { orderId: order.id },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "SHIPPING_CONFIRMATION",
      status: "PENDING",
      idempotencyKey: `sc_${order.id}`,
    });

    // Poll 3: the order is no longer SUBMITTED, so it drops out of the work list
    // and is never re-polled — idempotent, still exactly one shipping email.
    await fulfillmentService.pollOpenShipments();
    persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.status).toBe("FULFILLED");
    expect(
      await prisma.outboxMessage.count({
        where: { orderId: order.id, type: "SHIPPING_CONFIRMATION" },
      }),
    ).toBe(1);
  });

  it("moves a provider-cancelled order to FAILED over two polls, idempotently", async () => {
    const tenant = await freshTenant();
    // An external id carrying the terminal-fail marker: the mock accepts it, then
    // reports it "canceled" (not shipped) once past the first poll — the poll cron's
    // terminal-exit path (#151), end-to-end against a real Postgres.
    const externalId = uniqueId(`mock-${MOCK_TERMINAL_FAIL_MARKER}`);
    const order = await seedSubmittedOrder(tenant.id, externalId);

    // Poll 1: the mock still reports "submitted" (no tracking) — the order is left
    // SUBMITTED and nothing is enqueued, exactly like the shipped progression.
    await fulfillmentService.pollOpenShipments();
    let persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.status).toBe("PAID");
    expect(persisted.fulfillmentStatus).toBe("SUBMITTED");

    // Poll 2: the mock now reports "canceled" (terminal) — reconcile the fulfillment
    // to FAILED. Order.status STAYS PAID (a refund/re-order is an operator decision),
    // the raw provider status is persisted for admin display, no tracking is written,
    // and — unlike a shipment — NO email is enqueued (a cancellation isn't a shopper
    // notification).
    await fulfillmentService.pollOpenShipments();
    persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.status).toBe("PAID");
    expect(persisted.fulfillmentStatus).toBe("FAILED");
    expect(persisted.fulfillmentProviderStatus).toBe("canceled");
    expect(persisted.trackingNumber).toBeNull();
    expect(
      await prisma.outboxMessage.count({ where: { orderId: order.id } }),
    ).toBe(0);

    // Poll 3: no longer SUBMITTED, so it drops out of findSubmittedForPolling and is
    // never re-polled — the whole point of the terminal exit. Idempotent.
    await fulfillmentService.pollOpenShipments();
    persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.fulfillmentStatus).toBe("FAILED");
    expect(persisted.status).toBe("PAID");
  });
});

describe("pollOpenShipments — stuck open shipment (#155)", () => {
  // Comfortably past STUCK_SUBMITTED_THRESHOLD_MS (10 days); a wide margin keeps the
  // case robust to a threshold tweak (an operator-tunable knob). Age is anchored on
  // `createdAt`, which `seedSubmittedOrder` backdates. Per the file header, every
  // assertion below is on THIS order's persisted row — the per-run tally is an
  // aggregate over the platform-wide poll and is proven in the unit tests instead.
  const STUCK_AGO = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);

  it("flags a stuck open shipment once, idempotently, without ever terminalizing it", async () => {
    const tenant = await freshTenant();
    // The onhold marker keeps the mock's getTracking in flight on every poll (never a
    // tracking number, never a terminal failure) — the only way to hold an order open
    // across polls long enough to observe the age-based stuck check end-to-end (the
    // plain progression resolves to shipped by the second poll).
    const externalId = uniqueId(`mock-${MOCK_ONHOLD_MARKER}`);
    const order = await seedSubmittedOrder(tenant.id, externalId, {
      createdAt: STUCK_AGO,
    });

    // Poll 1: past the threshold and never shipping — surfaced as stuck, stamping
    // `fulfillmentStuckAt`. Deliberately the inverse of the #151 terminal exit: the
    // order is surfaced but NOT terminalized — still SUBMITTED + PAID, no tracking —
    // because an onhold order can still ship and must keep being polled.
    await fulfillmentService.pollOpenShipments();
    let persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    const stampedAt = persisted.fulfillmentStuckAt;
    expect(stampedAt).not.toBeNull();
    expect(persisted.fulfillmentStatus).toBe("SUBMITTED");
    expect(persisted.status).toBe("PAID");
    expect(persisted.trackingNumber).toBeNull();

    // Poll 2: already surfaced — idempotent. The stamp does not move (so the operator
    // isn't re-alerted on every cron tick), and the order is still SUBMITTED + PAID.
    await fulfillmentService.pollOpenShipments();
    persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.fulfillmentStuckAt).toEqual(stampedAt);
    expect(persisted.fulfillmentStatus).toBe("SUBMITTED");
    expect(persisted.status).toBe("PAID");
  });

  it("never flags a normally-progressing (recent) order as stuck", async () => {
    const tenant = await freshTenant();
    const externalId = uniqueId(`mock-${MOCK_ONHOLD_MARKER}`);
    // createdAt defaults to now — nowhere near the threshold.
    const order = await seedSubmittedOrder(tenant.id, externalId);

    await fulfillmentService.pollOpenShipments();

    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
        .fulfillmentStuckAt,
    ).toBeNull();
  });
});
