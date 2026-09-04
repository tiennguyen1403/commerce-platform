import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { FulfillmentStatus, OrderStatus } from "@prisma/client";
import {
  orderRepository,
  type CreateOrderInput,
} from "@/server/repositories/order.repository";
import {
  InsufficientStockError,
  OrderNumberTakenError,
} from "@/server/order.errors";
import type { ShippingAddress } from "@/server/fulfillment/provider";
import {
  createTestTenant,
  deleteTenantDeep,
  prisma,
  uniqueId,
} from "@/test/integration-db";

/**
 * Integration tests for `orderRepository.markPaidByPaymentIntent` against a real
 * Postgres — the crown jewel of the payment path. Its guarantees live in the
 * database, not the code: the status-guarded `updateMany` is the sole idempotency
 * point (exactly-once PENDING → PAID under racing webhook deliveries) and the
 * `stock >= quantity` guarded decrement is what keeps inventory from going
 * negative on an oversell. A mock can't exercise row locking or `updateMany`
 * count semantics, so these run against the same Postgres the app uses.
 */

// Each test gets its own throwaway tenant; clean them up afterwards (scoped, not
// a truncation) so a shared local database doesn't accumulate rows across runs.
const tenantIds: string[] = [];
async function freshTenant() {
  const tenant = await createTestTenant();
  tenantIds.push(tenant.id);
  return tenant;
}

// `User` is platform-wide (not tenant-scoped), so `deleteTenantDeep` never
// touches it — track and clean up any test-seeded shopper separately.
const userIds: string[] = [];
/** Seed a minimal global shopper `User` row (id/name/email are its only
 *  required fields) for a `userId`-linkage test. */
async function freshUser() {
  const user = await prisma.user.create({
    data: {
      id: uniqueId("user"),
      name: "Test Shopper",
      email: `${uniqueId("shopper")}@example.com`,
    },
  });
  userIds.push(user.id);
  return user;
}

afterEach(async () => {
  await Promise.all(tenantIds.splice(0).map(deleteTenantDeep));
  // Orders referencing these users are already gone via deleteTenantDeep above
  // (Order.user is onDelete: SetNull, but the row itself is deleted, not
  // de-linked), so this is a plain, unconstrained delete.
  await prisma.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Seed a product with a single variant and return that variant. */
async function seedVariant(
  tenantId: string,
  opts: {
    stock: number;
    reserved?: number;
    priceCents?: number;
    name?: string;
  },
) {
  const product = await prisma.product.create({
    data: {
      tenantId,
      title: "Tee",
      slug: uniqueId("product"),
      status: "ACTIVE",
      variants: {
        create: {
          sku: uniqueId("sku"),
          name: opts.name ?? "Blue",
          priceCents: opts.priceCents ?? 1000,
          stock: opts.stock,
          reserved: opts.reserved ?? 0,
        },
      },
    },
    include: { variants: true },
  });
  return product.variants[0];
}

type SeedLine = {
  variantId: string;
  qty: number;
  priceCents: number;
  titleSnapshot?: string;
};

/** Seed a PENDING order carrying the given lines and PaymentIntent id. Pass
 *  `opts.shipping` to persist a complete shipping address (the FULFILLMENT_SUBMISSION
 *  enqueue gate, #139); omit it for a guest/legacy order that has none. */
async function seedPendingOrder(
  tenantId: string,
  stripePaymentIntentId: string,
  lines: SeedLine[],
  opts: { shipping?: ShippingAddress } = {},
) {
  return prisma.order.create({
    data: {
      tenantId,
      orderNumber: uniqueId("order"),
      status: "PENDING",
      email: "shopper@example.com",
      totalCents: lines.reduce((sum, l) => sum + l.priceCents * l.qty, 0),
      currency: "usd",
      stripePaymentIntentId,
      ...(opts.shipping
        ? {
            shipName: opts.shipping.name,
            shipLine1: opts.shipping.line1,
            shipLine2: opts.shipping.line2?.trim() || null,
            shipCity: opts.shipping.city,
            shipState: opts.shipping.state?.trim() || null,
            shipPostalCode: opts.shipping.postalCode,
            shipCountry: opts.shipping.country,
          }
        : {}),
      items: {
        create: lines.map((l) => ({
          variantId: l.variantId,
          titleSnapshot: l.titleSnapshot ?? "Tee / Blue",
          priceCents: l.priceCents,
          quantity: l.qty,
        })),
      },
    },
  });
}

/** Seed an order in any status (with optional lines and an explicit `createdAt`
 *  for ordering tests). `email`/`currency`/`totalCents`/`userId` are overridable so
 *  the reuse-candidate filter suite can vary them independently of the lines
 *  (`userId` defaults to null — a guest order). Used by the lifecycle, list, sweep,
 *  and reuse suites below. */
async function seedOrder(
  tenantId: string,
  opts: {
    status?: OrderStatus;
    lines?: SeedLine[];
    stripePaymentIntentId?: string;
    createdAt?: Date;
    email?: string;
    currency?: string;
    totalCents?: number;
    userId?: string | null;
    fulfillmentStatus?: FulfillmentStatus;
    fulfillmentExternalId?: string;
  } = {},
) {
  const lines = opts.lines ?? [];
  return prisma.order.create({
    data: {
      tenantId,
      orderNumber: uniqueId("order"),
      status: opts.status ?? "PENDING",
      email: opts.email ?? "shopper@example.com",
      userId: opts.userId ?? null,
      totalCents:
        opts.totalCents ??
        lines.reduce((sum, l) => sum + l.priceCents * l.qty, 0),
      currency: opts.currency ?? "usd",
      stripePaymentIntentId: opts.stripePaymentIntentId ?? uniqueId("pi"),
      ...(opts.fulfillmentStatus
        ? { fulfillmentStatus: opts.fulfillmentStatus }
        : {}),
      ...(opts.fulfillmentExternalId
        ? { fulfillmentExternalId: opts.fulfillmentExternalId }
        : {}),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      items: {
        create: lines.map((l) => ({
          variantId: l.variantId,
          titleSnapshot: l.titleSnapshot ?? "Tee / Blue",
          priceCents: l.priceCents,
          quantity: l.qty,
        })),
      },
    },
    include: { items: true },
  });
}

/** A valid US shipping address `orderInput` attaches by default (#135), so every
 *  `createWithItems` call persists one and the round-trip can be asserted. `line2`
 *  is intentionally blank to exercise the empty→null column normalization. */
const TEST_SHIPPING: ShippingAddress = {
  name: "Ada Lovelace",
  line1: "1 Analytical Ave",
  line2: "",
  city: "San Francisco",
  state: "CA",
  postalCode: "94103",
  country: "US",
};

/** Build a `CreateOrderInput` (the shape `createWithItems` reserves + writes). */
function orderInput(
  tenantId: string,
  lines: SeedLine[],
  overrides: {
    id?: string;
    orderNumber?: string;
    stripePaymentIntentId?: string;
    userId?: string | null;
    shippingAddress?: ShippingAddress;
  } = {},
): CreateOrderInput {
  return {
    id: overrides.id ?? uniqueId("order-id"),
    tenantId,
    orderNumber: overrides.orderNumber ?? uniqueId("order"),
    email: "shopper@example.com",
    userId: overrides.userId ?? null,
    shippingAddress: overrides.shippingAddress ?? TEST_SHIPPING,
    totalCents: lines.reduce((sum, l) => sum + l.priceCents * l.qty, 0),
    currency: "usd",
    stripePaymentIntentId: overrides.stripePaymentIntentId ?? uniqueId("pi"),
    items: lines.map((l) => ({
      variantId: l.variantId,
      titleSnapshot: l.titleSnapshot ?? "Tee / Blue",
      priceCents: l.priceCents,
      quantity: l.qty,
    })),
  };
}

describe("orderRepository.markPaidByPaymentIntent (integration)", () => {
  it("flips PENDING → PAID and decrements stock on the first delivery", async () => {
    const tenant = await freshTenant();
    const variant = await seedVariant(tenant.id, {
      stock: 10,
      priceCents: 1500,
    });
    const intent = uniqueId("pi");
    await seedPendingOrder(tenant.id, intent, [
      { variantId: variant.id, qty: 3, priceCents: 1500 },
    ]);

    const result = await orderRepository.markPaidByPaymentIntent(
      tenant.id,
      intent,
    );

    expect(result.transitioned).toBe(true);
    // Narrow the union (unreachable after the assert above) so `.order` is typed.
    if (!result.transitioned) return;
    expect(result.shortfalls).toEqual([]);
    expect(result.order.stripePaymentIntentId).toBe(intent);

    // The returned `order` is the pre-flip snapshot (read before the update), so
    // its status is still PENDING — verify PAID against the committed row.
    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: result.order.id },
    });
    expect(persisted.status).toBe("PAID");

    const afterStock = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
    });
    expect(afterStock.stock).toBe(7);
  });

  it("enqueues exactly one PENDING order-confirmation in the flip transaction", async () => {
    const tenant = await freshTenant();
    const variant = await seedVariant(tenant.id, {
      stock: 5,
      priceCents: 1000,
    });
    const intent = uniqueId("pi");
    const order = await seedPendingOrder(tenant.id, intent, [
      { variantId: variant.id, qty: 1, priceCents: 1000 },
    ]);

    await orderRepository.markPaidByPaymentIntent(tenant.id, intent);

    // The transactional outbox (#30): the confirmation is queued atomically with
    // PENDING → PAID, so a paid order always has exactly one message to send.
    const messages = await prisma.outboxMessage.findMany({
      where: { tenantId: tenant.id, orderId: order.id },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "ORDER_CONFIRMATION",
      status: "PENDING",
      attempts: 0,
      idempotencyKey: `oc_${order.id}`,
    });
  });

  it("also enqueues a FULFILLMENT_SUBMISSION in the flip transaction when the order has a shipping address", async () => {
    const tenant = await freshTenant();
    const variant = await seedVariant(tenant.id, {
      stock: 5,
      priceCents: 1000,
    });
    const intent = uniqueId("pi");
    const order = await seedPendingOrder(
      tenant.id,
      intent,
      [{ variantId: variant.id, qty: 1, priceCents: 1000 }],
      { shipping: TEST_SHIPPING },
    );

    await orderRepository.markPaidByPaymentIntent(tenant.id, intent);

    // A shippable paid order queues BOTH the confirmation and the provider
    // submission (M4 #139), atomically with the flip, under distinct keys.
    const messages = await prisma.outboxMessage.findMany({
      where: { tenantId: tenant.id, orderId: order.id },
    });
    expect(messages.map((m) => m.type).sort()).toEqual([
      "FULFILLMENT_SUBMISSION",
      "ORDER_CONFIRMATION",
    ]);
    expect(
      messages.find((m) => m.type === "FULFILLMENT_SUBMISSION"),
    ).toMatchObject({
      status: "PENDING",
      attempts: 0,
      idempotencyKey: `fs_${order.id}`,
    });
  });

  it("does not enqueue a FULFILLMENT_SUBMISSION when the order has no shipping address", async () => {
    const tenant = await freshTenant();
    const variant = await seedVariant(tenant.id, { stock: 5 });
    const intent = uniqueId("pi");
    // seedPendingOrder without `shipping` → a guest/legacy order with no address.
    const order = await seedPendingOrder(tenant.id, intent, [
      { variantId: variant.id, qty: 1, priceCents: 1000 },
    ]);

    await orderRepository.markPaidByPaymentIntent(tenant.id, intent);

    // Nowhere to ship, so no submission is enqueued — it could only fail with a
    // missing address. The confirmation email still goes out.
    const types = (
      await prisma.outboxMessage.findMany({ where: { orderId: order.id } })
    ).map((m) => m.type);
    expect(types).toEqual(["ORDER_CONFIRMATION"]);
  });

  it("does not enqueue a second outbox message on a duplicate delivery", async () => {
    const tenant = await freshTenant();
    const variant = await seedVariant(tenant.id, { stock: 5 });
    const intent = uniqueId("pi");
    const order = await seedPendingOrder(tenant.id, intent, [
      { variantId: variant.id, qty: 1, priceCents: 1000 },
    ]);

    await orderRepository.markPaidByPaymentIntent(tenant.id, intent);
    await orderRepository.markPaidByPaymentIntent(tenant.id, intent);

    // Only the single PENDING → PAID transition enqueues; the duplicate delivery
    // finds the order already PAID and touches nothing (and the unique
    // idempotencyKey would reject a second write even if it tried).
    const count = await prisma.outboxMessage.count({
      where: { orderId: order.id },
    });
    expect(count).toBe(1);
  });

  it("is a no-op on a duplicate delivery — no second decrement", async () => {
    const tenant = await freshTenant();
    const variant = await seedVariant(tenant.id, { stock: 10 });
    const intent = uniqueId("pi");
    await seedPendingOrder(tenant.id, intent, [
      { variantId: variant.id, qty: 4, priceCents: 1000 },
    ]);

    const first = await orderRepository.markPaidByPaymentIntent(
      tenant.id,
      intent,
    );
    const second = await orderRepository.markPaidByPaymentIntent(
      tenant.id,
      intent,
    );

    expect(first.transitioned).toBe(true);
    // The order exists but is no longer PENDING → reported as already-processed.
    expect(second).toEqual({ transitioned: false, orderExisted: true });

    const afterStock = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
    });
    expect(afterStock.stock).toBe(6); // decremented once (10 - 4), never twice
  });

  it("reports orderExisted:false for an unknown PaymentIntent", async () => {
    const tenant = await freshTenant();

    const result = await orderRepository.markPaidByPaymentIntent(
      tenant.id,
      uniqueId("pi-missing"),
    );

    expect(result).toEqual({ transitioned: false, orderExisted: false });
  });

  it("does not cross the tenant boundary — a foreign intent is invisible", async () => {
    const owner = await freshTenant();
    const other = await freshTenant();
    const variant = await seedVariant(owner.id, { stock: 5 });
    const intent = uniqueId("pi");
    await seedPendingOrder(owner.id, intent, [
      { variantId: variant.id, qty: 1, priceCents: 1000 },
    ]);

    // Same intent id, wrong tenant: it must resolve as unknown and touch nothing.
    const result = await orderRepository.markPaidByPaymentIntent(
      other.id,
      intent,
    );
    expect(result).toEqual({ transitioned: false, orderExisted: false });

    const stock = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
    });
    expect(stock.stock).toBe(5);
    const stillPending = await prisma.order.findFirstOrThrow({
      where: { tenantId: owner.id, stripePaymentIntentId: intent },
    });
    expect(stillPending.status).toBe("PENDING");
  });

  it("stands the order PAID but leaves an under-stocked line untouched, reporting the shortfall", async () => {
    const tenant = await freshTenant();
    const ample = await seedVariant(tenant.id, { stock: 10, name: "Ample" });
    const scarce = await seedVariant(tenant.id, { stock: 2, name: "Scarce" });
    const intent = uniqueId("pi");
    await seedPendingOrder(tenant.id, intent, [
      {
        variantId: ample.id,
        qty: 2,
        priceCents: 1000,
        titleSnapshot: "Tee / Ample",
      },
      {
        variantId: scarce.id,
        qty: 5,
        priceCents: 2000,
        titleSnapshot: "Tee / Scarce",
      },
    ]);

    const result = await orderRepository.markPaidByPaymentIntent(
      tenant.id,
      intent,
    );

    expect(result.transitioned).toBe(true);
    if (!result.transitioned) return;
    // Only the line that couldn't be covered is a shortfall; `available` is the
    // (untouched) on-hand count the guard found too few of.
    expect(result.shortfalls).toEqual([
      {
        variantId: scarce.id,
        titleSnapshot: "Tee / Scarce",
        ordered: 5,
        available: 2,
      },
    ]);

    // The payment is real, so the order stands PAID regardless of the oversell.
    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: result.order.id },
    });
    expect(persisted.status).toBe("PAID");

    // The allocatable line decremented; the short line is left exactly as it was.
    const ampleAfter = await prisma.productVariant.findUniqueOrThrow({
      where: { id: ample.id },
    });
    const scarceAfter = await prisma.productVariant.findUniqueOrThrow({
      where: { id: scarce.id },
    });
    expect(ampleAfter.stock).toBe(8);
    expect(scarceAfter.stock).toBe(2);
  });

  it("flags the order oversold when a line couldn't be fully allocated", async () => {
    const tenant = await freshTenant();
    const scarce = await seedVariant(tenant.id, { stock: 2, name: "Scarce" });
    const intent = uniqueId("pi");
    await seedPendingOrder(tenant.id, intent, [
      { variantId: scarce.id, qty: 5, priceCents: 2000 },
    ]);

    const result = await orderRepository.markPaidByPaymentIntent(
      tenant.id,
      intent,
    );
    expect(result.transitioned).toBe(true);
    if (!result.transitioned) return;

    // The durable oversell flag is written in the same transaction as the flip —
    // what the admin order view and the confirmation email (#40) read long after
    // the capture, unlike the transient `shortfalls` return.
    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: result.order.id },
    });
    expect(persisted.oversold).toBe(true);
  });

  it("leaves oversold false when every line is fully allocated", async () => {
    const tenant = await freshTenant();
    const variant = await seedVariant(tenant.id, { stock: 10 });
    const intent = uniqueId("pi");
    await seedPendingOrder(tenant.id, intent, [
      { variantId: variant.id, qty: 3, priceCents: 1000 },
    ]);

    const result = await orderRepository.markPaidByPaymentIntent(
      tenant.id,
      intent,
    );
    expect(result.transitioned).toBe(true);
    if (!result.transitioned) return;

    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: result.order.id },
    });
    expect(persisted.oversold).toBe(false);
  });

  it("transitions exactly once under a concurrent double-delivery (Promise.all)", async () => {
    const tenant = await freshTenant();
    const variant = await seedVariant(tenant.id, { stock: 10 });
    const intent = uniqueId("pi");
    await seedPendingOrder(tenant.id, intent, [
      { variantId: variant.id, qty: 3, priceCents: 1000 },
    ]);

    // Two webhook deliveries land at once. Row locking on the guarded
    // `updateMany({status: PENDING})` must let exactly one win.
    const [a, b] = await Promise.all([
      orderRepository.markPaidByPaymentIntent(tenant.id, intent),
      orderRepository.markPaidByPaymentIntent(tenant.id, intent),
    ]);

    const transitioned = [a, b].filter((r) => r.transitioned);
    expect(transitioned).toHaveLength(1);
    const other = [a, b].find((r) => !r.transitioned);
    expect(other).toEqual({ transitioned: false, orderExisted: true });

    const afterStock = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
    });
    expect(afterStock.stock).toBe(7); // decremented exactly once (10 - 3)
    const persisted = await prisma.order.findFirstOrThrow({
      where: { tenantId: tenant.id, stripePaymentIntentId: intent },
    });
    expect(persisted.status).toBe("PAID");
  });

  it("releases the reservation when it reconciles the sale at PAID", async () => {
    const tenant = await freshTenant();
    // 10 on hand, 3 held by this order's PENDING reservation.
    const variant = await seedVariant(tenant.id, { stock: 10, reserved: 3 });
    const intent = uniqueId("pi");
    await seedPendingOrder(tenant.id, intent, [
      { variantId: variant.id, qty: 3, priceCents: 1000 },
    ]);

    await orderRepository.markPaidByPaymentIntent(tenant.id, intent);

    // `stock` drops by the sold 3 and the 3-unit hold is released together, so
    // `available = stock - reserved` stays correct (7 - 0 = 7 sellable).
    const after = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
    });
    expect(after.stock).toBe(7);
    expect(after.reserved).toBe(0);
  });

  it("floors the reservation release at 0 on PAID (drift-safe)", async () => {
    const tenant = await freshTenant();
    // Only 1 unit held though the line is for 3 (a drift edge): the release must
    // not drive `reserved` negative.
    const variant = await seedVariant(tenant.id, { stock: 10, reserved: 1 });
    const intent = uniqueId("pi");
    await seedPendingOrder(tenant.id, intent, [
      { variantId: variant.id, qty: 3, priceCents: 1000 },
    ]);

    await orderRepository.markPaidByPaymentIntent(tenant.id, intent);

    const after = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
    });
    expect(after.stock).toBe(7); // decremented: stock 10 >= 3
    expect(after.reserved).toBe(0); // GREATEST(1 - 3, 0)
  });
});

describe("orderRepository.createWithItems (reservation, integration)", () => {
  it("reserves each line and writes the PENDING order + items", async () => {
    const tenant = await freshTenant();
    const variant = await seedVariant(tenant.id, { stock: 10 });

    const created = await orderRepository.createWithItems(
      orderInput(tenant.id, [
        { variantId: variant.id, qty: 3, priceCents: 1000 },
      ]),
    );

    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: created.id },
      include: { items: true },
    });
    expect(persisted.status).toBe("PENDING");
    expect(persisted.items).toHaveLength(1);

    // #135: the shipping address is persisted in the same create transaction; a
    // blank line2 is normalized to null (the "not provided" column convention).
    expect(persisted.shipName).toBe(TEST_SHIPPING.name);
    expect(persisted.shipLine1).toBe(TEST_SHIPPING.line1);
    expect(persisted.shipLine2).toBeNull();
    expect(persisted.shipCity).toBe(TEST_SHIPPING.city);
    expect(persisted.shipState).toBe(TEST_SHIPPING.state);
    expect(persisted.shipPostalCode).toBe(TEST_SHIPPING.postalCode);
    expect(persisted.shipCountry).toBe("US");

    // Inventory is held: `reserved` bumped, physical `stock` untouched.
    const after = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
    });
    expect(after.stock).toBe(10);
    expect(after.reserved).toBe(3);
  });

  it("rejects and writes nothing when a line exceeds sellable stock", async () => {
    const tenant = await freshTenant();
    const variant = await seedVariant(tenant.id, { stock: 2 });

    await expect(
      orderRepository.createWithItems(
        orderInput(tenant.id, [
          { variantId: variant.id, qty: 3, priceCents: 1000 },
        ]),
      ),
    ).rejects.toBeInstanceOf(InsufficientStockError);

    // Rolled back: no partial hold, no orphan order.
    const after = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
    });
    expect(after.reserved).toBe(0);
    expect(await prisma.order.count({ where: { tenantId: tenant.id } })).toBe(
      0,
    );
  });

  it("honors existing reservations — available is stock minus reserved", async () => {
    const tenant = await freshTenant();
    // 5 on hand, 4 already held → only 1 sellable.
    const variant = await seedVariant(tenant.id, { stock: 5, reserved: 4 });

    await expect(
      orderRepository.createWithItems(
        orderInput(tenant.id, [
          { variantId: variant.id, qty: 2, priceCents: 1000 },
        ]),
      ),
    ).rejects.toBeInstanceOf(InsufficientStockError);

    // The last sellable unit can still be reserved.
    await orderRepository.createWithItems(
      orderInput(tenant.id, [
        { variantId: variant.id, qty: 1, priceCents: 1000 },
      ]),
    );
    const after = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
    });
    expect(after.reserved).toBe(5);
  });

  it("rolls back earlier reservations when a later line is short", async () => {
    const tenant = await freshTenant();
    const ample = await seedVariant(tenant.id, { stock: 10, name: "Ample" });
    const scarce = await seedVariant(tenant.id, { stock: 1, name: "Scarce" });

    await expect(
      orderRepository.createWithItems(
        orderInput(tenant.id, [
          { variantId: ample.id, qty: 2, priceCents: 1000 },
          { variantId: scarce.id, qty: 3, priceCents: 2000 },
        ]),
      ),
    ).rejects.toBeInstanceOf(InsufficientStockError);

    // The whole transaction rolled back — neither line holds a reservation.
    const ampleAfter = await prisma.productVariant.findUniqueOrThrow({
      where: { id: ample.id },
    });
    const scarceAfter = await prisma.productVariant.findUniqueOrThrow({
      where: { id: scarce.id },
    });
    expect(ampleAfter.reserved).toBe(0);
    expect(scarceAfter.reserved).toBe(0);
    expect(await prisma.order.count({ where: { tenantId: tenant.id } })).toBe(
      0,
    );
  });

  it("reserves the last unit exactly once under concurrent checkouts", async () => {
    const tenant = await freshTenant();
    const variant = await seedVariant(tenant.id, { stock: 1 });

    // Two shoppers race for the single unit. The atomic reserve guard
    // (`stock - reserved >= qty`) under row locking must let exactly one win —
    // the other re-checks the committed row, matches 0 rows, and is turned away.
    const results = await Promise.allSettled([
      orderRepository.createWithItems(
        orderInput(tenant.id, [
          { variantId: variant.id, qty: 1, priceCents: 1000 },
        ]),
      ),
      orderRepository.createWithItems(
        orderInput(tenant.id, [
          { variantId: variant.id, qty: 1, priceCents: 1000 },
        ]),
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      InsufficientStockError,
    );

    // Reserved exactly once (never oversold), and exactly one order written.
    const after = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
    });
    expect(after.reserved).toBe(1);
    expect(await prisma.order.count({ where: { tenantId: tenant.id } })).toBe(
      1,
    );
  });

  it("reserve → pay conserves availability (full lifecycle)", async () => {
    const tenant = await freshTenant();
    const variant = await seedVariant(tenant.id, { stock: 5 });
    const pi = uniqueId("pi");

    await orderRepository.createWithItems(
      orderInput(
        tenant.id,
        [{ variantId: variant.id, qty: 2, priceCents: 1000 }],
        { stripePaymentIntentId: pi },
      ),
    );
    // Held: stock 5, reserved 2 → available 3.
    const held = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
    });
    expect(held).toMatchObject({ stock: 5, reserved: 2 });

    await orderRepository.markPaidByPaymentIntent(tenant.id, pi);
    // Sold: stock 3, reserved 0 → available 3 (conserved across the sale).
    const settled = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
    });
    expect(settled).toMatchObject({ stock: 3, reserved: 0 });
  });

  it("re-reserves cleanly after an orderNumber collision — no leaked hold", async () => {
    const tenant = await freshTenant();
    const variant = await seedVariant(tenant.id, { stock: 10 });

    // Occupy an orderNumber (unique per [tenantId, orderNumber]) so the first
    // attempt's insert collides. This bare order holds no items → reserved is 0.
    const taken = uniqueId("order");
    await prisma.order.create({
      data: {
        tenantId: tenant.id,
        orderNumber: taken,
        status: "PENDING",
        email: "prior@example.com",
        totalCents: 1000,
        currency: "usd",
        stripePaymentIntentId: uniqueId("pi"),
      },
    });

    // First attempt reserves, then the insert hits the unique constraint, so the
    // whole transaction — reservation included — rolls back to OrderNumberTakenError.
    await expect(
      orderRepository.createWithItems(
        orderInput(
          tenant.id,
          [{ variantId: variant.id, qty: 2, priceCents: 1000 }],
          { orderNumber: taken },
        ),
      ),
    ).rejects.toBeInstanceOf(OrderNumberTakenError);

    const afterFail = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
    });
    expect(afterFail.reserved).toBe(0); // rolled back — no orphaned hold

    // The service's retry with a fresh number now succeeds and reserves exactly
    // once: `reserved` is qty, never 2·qty (the failed attempt left nothing).
    await orderRepository.createWithItems(
      orderInput(tenant.id, [
        { variantId: variant.id, qty: 2, priceCents: 1000 },
      ]),
    );
    const afterRetry = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
    });
    expect(afterRetry.reserved).toBe(2);
  });

  it("persists the signed-in shopper's userId, and defaults to null for a guest (#102)", async () => {
    const tenant = await freshTenant();
    const variant = await seedVariant(tenant.id, { stock: 10 });
    const shopper = await freshUser();

    const linked = await orderRepository.createWithItems(
      orderInput(
        tenant.id,
        [{ variantId: variant.id, qty: 1, priceCents: 1000 }],
        { userId: shopper.id },
      ),
    );
    const persistedLinked = await prisma.order.findUniqueOrThrow({
      where: { id: linked.id },
    });
    expect(persistedLinked.userId).toBe(shopper.id);

    // Guest checkout: the default `orderInput` (no override) must persist a real
    // null, not leave the column undefined/omitted.
    const guestOrder = await orderRepository.createWithItems(
      orderInput(tenant.id, [
        { variantId: variant.id, qty: 1, priceCents: 1000 },
      ]),
    );
    const persistedGuest = await prisma.order.findUniqueOrThrow({
      where: { id: guestOrder.id },
    });
    expect(persistedGuest.userId).toBeNull();
  });
});

describe("orderRepository.cancelPendingAndRelease (integration)", () => {
  it("cancels a PENDING order and releases its reservation", async () => {
    const tenant = await freshTenant();
    // 10 on hand, 3 held by this order's PENDING reservation.
    const variant = await seedVariant(tenant.id, { stock: 10, reserved: 3 });
    const order = await seedOrder(tenant.id, {
      status: "PENDING",
      lines: [{ variantId: variant.id, qty: 3, priceCents: 1000 }],
    });

    const result = await orderRepository.cancelPendingAndRelease(
      tenant.id,
      order.id,
    );
    expect(result).toEqual({ transitioned: true });

    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.status).toBe("CANCELLED");

    // The hold is freed and physical stock is untouched (a PENDING order never
    // decremented it), so those units are sellable again.
    const after = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
    });
    expect(after.stock).toBe(10);
    expect(after.reserved).toBe(0);
  });

  it("floors the reservation release at 0 (drift-safe)", async () => {
    const tenant = await freshTenant();
    // Only 1 unit held though the line is for 3 (a drift edge): the release must
    // not drive `reserved` negative.
    const variant = await seedVariant(tenant.id, { stock: 10, reserved: 1 });
    const order = await seedOrder(tenant.id, {
      status: "PENDING",
      lines: [{ variantId: variant.id, qty: 3, priceCents: 1000 }],
    });

    await orderRepository.cancelPendingAndRelease(tenant.id, order.id);

    const after = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
    });
    expect(after.reserved).toBe(0); // GREATEST(1 - 3, 0)
  });

  it("is a no-op on an order that isn't PENDING, reporting its status", async () => {
    const tenant = await freshTenant();
    const variant = await seedVariant(tenant.id, { stock: 10, reserved: 0 });
    // A PAID order is past PENDING — this leg can't cancel it.
    const order = await seedOrder(tenant.id, {
      status: "PAID",
      lines: [{ variantId: variant.id, qty: 2, priceCents: 1000 }],
    });

    const result = await orderRepository.cancelPendingAndRelease(
      tenant.id,
      order.id,
    );
    expect(result).toEqual({ transitioned: false, currentStatus: "PAID" });

    // Untouched: still PAID, and no phantom release drove `reserved` negative.
    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.status).toBe("PAID");
    const after = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
    });
    expect(after.reserved).toBe(0);
  });

  it("reports currentStatus:null for an unknown order id", async () => {
    const tenant = await freshTenant();
    const result = await orderRepository.cancelPendingAndRelease(
      tenant.id,
      uniqueId("order-missing"),
    );
    expect(result).toEqual({ transitioned: false, currentStatus: null });
  });

  it("does not cross the tenant boundary — a foreign order is invisible", async () => {
    const owner = await freshTenant();
    const other = await freshTenant();
    const variant = await seedVariant(owner.id, { stock: 5, reserved: 2 });
    const order = await seedOrder(owner.id, {
      status: "PENDING",
      lines: [{ variantId: variant.id, qty: 2, priceCents: 1000 }],
    });

    // Same order id, wrong tenant: unknown, and it must touch nothing.
    const result = await orderRepository.cancelPendingAndRelease(
      other.id,
      order.id,
    );
    expect(result).toEqual({ transitioned: false, currentStatus: null });

    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.status).toBe("PENDING");
    const after = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
    });
    expect(after.reserved).toBe(2); // hold intact
  });

  it("cancels exactly once under a concurrent double-cancel (Promise.all)", async () => {
    const tenant = await freshTenant();
    // 5 reserved though this order holds 3 (2 belong to other in-flight orders):
    // a single release leaves 2, so `reserved === 2` proves the loser did NOT
    // release a second time (a double release would floor it to 0).
    const variant = await seedVariant(tenant.id, { stock: 10, reserved: 5 });
    const order = await seedOrder(tenant.id, {
      status: "PENDING",
      lines: [{ variantId: variant.id, qty: 3, priceCents: 1000 }],
    });

    // Two admins (or an admin + the sweep) cancel at once. Row locking on the
    // guarded updateMany must let exactly one win; the other sees CANCELLED.
    const [a, b] = await Promise.all([
      orderRepository.cancelPendingAndRelease(tenant.id, order.id),
      orderRepository.cancelPendingAndRelease(tenant.id, order.id),
    ]);

    const transitioned = [a, b].filter((r) => r.transitioned);
    expect(transitioned).toHaveLength(1);
    const loser = [a, b].find((r) => !r.transitioned);
    expect(loser).toEqual({ transitioned: false, currentStatus: "CANCELLED" });

    const after = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
    });
    expect(after.reserved).toBe(2); // released once (5 - 3), never twice
    expect(after.stock).toBe(10);
  });

  it("cancel racing markPaid on one PENDING order: exactly one wins, no corruption", async () => {
    const tenant = await freshTenant();
    // 10 on hand, 3 held by this order's reservation.
    const variant = await seedVariant(tenant.id, { stock: 10, reserved: 3 });
    const intent = uniqueId("pi");
    const order = await seedOrder(tenant.id, {
      status: "PENDING",
      stripePaymentIntentId: intent,
      lines: [{ variantId: variant.id, qty: 3, priceCents: 1000 }],
    });

    // An admin cancels at the same instant the payment webhook confirms. Both
    // legs guard on `status: PENDING` and take the order row lock first, so they
    // serialize there: exactly one transitions, and the order can never end up
    // both cancelled and paid (or paid without its stock decremented).
    const [cancel, pay] = await Promise.all([
      orderRepository.cancelPendingAndRelease(tenant.id, order.id),
      orderRepository.markPaidByPaymentIntent(tenant.id, intent),
    ]);

    expect(
      [cancel.transitioned, pay.transitioned].filter(Boolean),
    ).toHaveLength(1);

    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    const after = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
    });
    // Either outcome frees the hold; only the winning sale touches physical stock.
    expect(after.reserved).toBe(0);
    if (cancel.transitioned) {
      expect(pay.transitioned).toBe(false);
      expect(persisted.status).toBe("CANCELLED");
      expect(after.stock).toBe(10); // cancel never decrements
    } else {
      expect(pay.transitioned).toBe(true);
      expect(persisted.status).toBe("PAID");
      expect(after.stock).toBe(7); // the sale decremented its 3 units
    }
  });
});

describe("orderRepository.markFulfilled (integration)", () => {
  it("marks a PAID order FULFILLED", async () => {
    const tenant = await freshTenant();
    const order = await seedOrder(tenant.id, { status: "PAID" });

    const result = await orderRepository.markFulfilled(tenant.id, order.id);
    expect(result).toEqual({ transitioned: true });

    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.status).toBe("FULFILLED");
  });

  it("is a no-op on an order that isn't PAID, reporting its status", async () => {
    const tenant = await freshTenant();
    const pending = await seedOrder(tenant.id, { status: "PENDING" });

    const result = await orderRepository.markFulfilled(tenant.id, pending.id);
    expect(result).toEqual({ transitioned: false, currentStatus: "PENDING" });

    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: pending.id },
    });
    expect(persisted.status).toBe("PENDING");
  });

  it("reports currentStatus:null for an unknown order id", async () => {
    const tenant = await freshTenant();
    const result = await orderRepository.markFulfilled(
      tenant.id,
      uniqueId("order-missing"),
    );
    expect(result).toEqual({ transitioned: false, currentStatus: null });
  });

  it("does not cross the tenant boundary — a foreign order is invisible", async () => {
    const owner = await freshTenant();
    const other = await freshTenant();
    const order = await seedOrder(owner.id, { status: "PAID" });

    const result = await orderRepository.markFulfilled(other.id, order.id);
    expect(result).toEqual({ transitioned: false, currentStatus: null });

    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.status).toBe("PAID");
  });

  it("does not touch stock or reservations (status-only attestation)", async () => {
    const tenant = await freshTenant();
    const variant = await seedVariant(tenant.id, { stock: 7, reserved: 2 });
    const order = await seedOrder(tenant.id, {
      status: "PAID",
      lines: [{ variantId: variant.id, qty: 3, priceCents: 1000 }],
    });

    await orderRepository.markFulfilled(tenant.id, order.id);

    const after = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
    });
    expect(after.stock).toBe(7);
    expect(after.reserved).toBe(2);
  });

  it("transitions exactly once under a concurrent double-fulfil (Promise.all)", async () => {
    const tenant = await freshTenant();
    const order = await seedOrder(tenant.id, { status: "PAID" });

    const [a, b] = await Promise.all([
      orderRepository.markFulfilled(tenant.id, order.id),
      orderRepository.markFulfilled(tenant.id, order.id),
    ]);

    const transitioned = [a, b].filter((r) => r.transitioned);
    expect(transitioned).toHaveLength(1);
    const loser = [a, b].find((r) => !r.transitioned);
    expect(loser).toEqual({ transitioned: false, currentStatus: "FULFILLED" });
  });
});

describe("orderRepository.markRefundedByPaymentIntent (integration)", () => {
  it("flips a PAID order → REFUNDED by its PaymentIntent", async () => {
    const tenant = await freshTenant();
    const intent = uniqueId("pi");
    const order = await seedOrder(tenant.id, {
      status: "PAID",
      stripePaymentIntentId: intent,
    });

    const result = await orderRepository.markRefundedByPaymentIntent(
      tenant.id,
      intent,
    );
    expect(result).toEqual({ transitioned: true });

    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.status).toBe("REFUNDED");
  });

  it("flips a FULFILLED order → REFUNDED too", async () => {
    const tenant = await freshTenant();
    const intent = uniqueId("pi");
    const order = await seedOrder(tenant.id, {
      status: "FULFILLED",
      stripePaymentIntentId: intent,
    });

    const result = await orderRepository.markRefundedByPaymentIntent(
      tenant.id,
      intent,
    );
    expect(result).toEqual({ transitioned: true });

    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.status).toBe("REFUNDED");
  });

  it("is a no-op on an order that isn't PAID/FULFILLED, reporting its status", async () => {
    const tenant = await freshTenant();
    const intent = uniqueId("pi");
    const order = await seedOrder(tenant.id, {
      status: "PENDING",
      stripePaymentIntentId: intent,
    });

    const result = await orderRepository.markRefundedByPaymentIntent(
      tenant.id,
      intent,
    );
    expect(result).toEqual({ transitioned: false, currentStatus: "PENDING" });

    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.status).toBe("PENDING");
  });

  it("is a no-op on a CANCELLED order, reporting its status", async () => {
    const tenant = await freshTenant();
    const intent = uniqueId("pi");
    // A refund arriving for a cancelled order is the realistic anomaly the guard
    // must reject: CANCELLED is not a refundable source state.
    const order = await seedOrder(tenant.id, {
      status: "CANCELLED",
      stripePaymentIntentId: intent,
    });

    const result = await orderRepository.markRefundedByPaymentIntent(
      tenant.id,
      intent,
    );
    expect(result).toEqual({ transitioned: false, currentStatus: "CANCELLED" });

    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.status).toBe("CANCELLED");
  });

  it("reports currentStatus:null for an unknown PaymentIntent", async () => {
    const tenant = await freshTenant();
    const result = await orderRepository.markRefundedByPaymentIntent(
      tenant.id,
      uniqueId("pi-missing"),
    );
    expect(result).toEqual({ transitioned: false, currentStatus: null });
  });

  it("does not cross the tenant boundary — a foreign intent is invisible", async () => {
    const owner = await freshTenant();
    const other = await freshTenant();
    const intent = uniqueId("pi");
    const order = await seedOrder(owner.id, {
      status: "PAID",
      stripePaymentIntentId: intent,
    });

    // Same intent id, wrong tenant: it must resolve as unknown and touch nothing.
    const result = await orderRepository.markRefundedByPaymentIntent(
      other.id,
      intent,
    );
    expect(result).toEqual({ transitioned: false, currentStatus: null });

    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.status).toBe("PAID");
  });

  it("is idempotent — a duplicate succeeded delivery flips once, then no-ops as REFUNDED", async () => {
    const tenant = await freshTenant();
    const intent = uniqueId("pi");
    await seedOrder(tenant.id, {
      status: "PAID",
      stripePaymentIntentId: intent,
    });

    const first = await orderRepository.markRefundedByPaymentIntent(
      tenant.id,
      intent,
    );
    const second = await orderRepository.markRefundedByPaymentIntent(
      tenant.id,
      intent,
    );

    expect(first).toEqual({ transitioned: true });
    // The order is now REFUNDED → the second delivery matches nothing.
    expect(second).toEqual({ transitioned: false, currentStatus: "REFUNDED" });
  });

  it("transitions exactly once under a concurrent double-delivery (Promise.all)", async () => {
    const tenant = await freshTenant();
    const intent = uniqueId("pi");
    await seedOrder(tenant.id, {
      status: "PAID",
      stripePaymentIntentId: intent,
    });

    // Two refund-webhook deliveries land at once. Row locking on the guarded
    // `updateMany({ status: { in: [PAID, FULFILLED] } })` must let exactly one win.
    const [a, b] = await Promise.all([
      orderRepository.markRefundedByPaymentIntent(tenant.id, intent),
      orderRepository.markRefundedByPaymentIntent(tenant.id, intent),
    ]);

    const transitioned = [a, b].filter((r) => r.transitioned);
    expect(transitioned).toHaveLength(1);
    const loser = [a, b].find((r) => !r.transitioned);
    expect(loser).toEqual({ transitioned: false, currentStatus: "REFUNDED" });
  });

  it("does not touch stock or reservations (refund restock is manual)", async () => {
    const tenant = await freshTenant();
    const variant = await seedVariant(tenant.id, { stock: 7, reserved: 2 });
    const intent = uniqueId("pi");
    await seedOrder(tenant.id, {
      status: "PAID",
      stripePaymentIntentId: intent,
      lines: [{ variantId: variant.id, qty: 3, priceCents: 1000 }],
    });

    await orderRepository.markRefundedByPaymentIntent(tenant.id, intent);

    // Refunding is a pure status flip: restock is left to the manual product-edit
    // form (goodwill vs return is ambiguous), so inventory is untouched.
    const after = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
    });
    expect(after.stock).toBe(7);
    expect(after.reserved).toBe(2);
  });
});

/**
 * `markShipped` — the SUBMITTED → SHIPPED reconcile the poll-fulfillment cron
 * drives (#140). Its guarantees live in the database: the `{status: PAID,
 * fulfillmentStatus: SUBMITTED}`-guarded `updateMany` is the sole idempotency
 * point (exactly-once PAID → FULFILLED under a repeated/racing poll) and doubles as
 * the money-safety guard against reconciling a refunded / manually-fulfilled order,
 * and the shipping-confirmation enqueue must be atomic with the flip. A mock can't
 * exercise row locking or `updateMany` count semantics, so these run against the
 * same Postgres the app uses.
 */
describe("orderRepository.markShipped (integration)", () => {
  const TRACKING = {
    providerStatus: "shipped",
    carrier: "UPS",
    trackingNumber: "1Z999AA10123456784",
    trackingUrl: "https://track.example.test/1Z999AA10123456784",
  };

  /** Seed a submitted-and-paid order — the poll's reconcilable state. */
  function seedSubmitted(
    tenantId: string,
    opts: { status?: OrderStatus; fulfillmentStatus?: FulfillmentStatus } = {},
  ) {
    return seedOrder(tenantId, {
      status: opts.status ?? "PAID",
      fulfillmentStatus: opts.fulfillmentStatus ?? "SUBMITTED",
      fulfillmentExternalId: uniqueId("ext"),
    });
  }

  async function outboxFor(orderId: string) {
    return prisma.outboxMessage.findMany({ where: { orderId } });
  }

  it("flips SUBMITTED+PAID → SHIPPED+FULFILLED, persists tracking, enqueues one email", async () => {
    const tenant = await freshTenant();
    const order = await seedSubmitted(tenant.id);

    const shipped = await orderRepository.markShipped(
      tenant.id,
      order.id,
      TRACKING,
    );
    expect(shipped).toBe(true);

    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.status).toBe("FULFILLED");
    expect(persisted.fulfillmentStatus).toBe("SHIPPED");
    expect(persisted.fulfillmentProviderStatus).toBe("shipped");
    expect(persisted.trackingCarrier).toBe(TRACKING.carrier);
    expect(persisted.trackingNumber).toBe(TRACKING.trackingNumber);
    expect(persisted.trackingUrl).toBe(TRACKING.trackingUrl);

    // The shipping-confirmation email is queued atomically with the flip, under a
    // distinct `sc_` key (the send path is M4-08). Exactly one, PENDING.
    const messages = await outboxFor(order.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "SHIPPING_CONFIRMATION",
      status: "PENDING",
      attempts: 0,
      idempotencyKey: `sc_${order.id}`,
    });
  });

  it("persists a null carrier/url when the shipment carries only a tracking number", async () => {
    const tenant = await freshTenant();
    const order = await seedSubmitted(tenant.id);

    await orderRepository.markShipped(tenant.id, order.id, {
      providerStatus: "fulfilled",
      carrier: null,
      trackingNumber: "TN-ONLY",
      trackingUrl: null,
    });

    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.trackingNumber).toBe("TN-ONLY");
    expect(persisted.trackingCarrier).toBeNull();
    expect(persisted.trackingUrl).toBeNull();
    expect(persisted.fulfillmentProviderStatus).toBe("fulfilled");
  });

  it("is idempotent — a duplicate poll flips once, then no-ops without a second email", async () => {
    const tenant = await freshTenant();
    const order = await seedSubmitted(tenant.id);

    const first = await orderRepository.markShipped(
      tenant.id,
      order.id,
      TRACKING,
    );
    const second = await orderRepository.markShipped(
      tenant.id,
      order.id,
      TRACKING,
    );

    expect(first).toBe(true);
    // The order is now SHIPPED → the second poll matches nothing and enqueues no
    // second email (the unique `sc_` key would also reject a duplicate).
    expect(second).toBe(false);
    expect(await outboxFor(order.id)).toHaveLength(1);
  });

  it("does not reconcile a REFUNDED order (status guard) — no flip, no email", async () => {
    const tenant = await freshTenant();
    // A refund flipped `status` after submission, leaving `fulfillmentStatus` at
    // SUBMITTED — the money-safety case the status guard exists for.
    const order = await seedSubmitted(tenant.id, { status: "REFUNDED" });

    const shipped = await orderRepository.markShipped(
      tenant.id,
      order.id,
      TRACKING,
    );
    expect(shipped).toBe(false);

    // Untouched: the blind `status = FULFILLED` must never regress a REFUNDED order.
    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.status).toBe("REFUNDED");
    expect(persisted.fulfillmentStatus).toBe("SUBMITTED");
    expect(persisted.trackingNumber).toBeNull();
    expect(await outboxFor(order.id)).toHaveLength(0);
  });

  it("does not reconcile a manually-FULFILLED order (status guard)", async () => {
    const tenant = await freshTenant();
    // A manual markFulfilled flipped `status` to FULFILLED, leaving fulfillmentStatus
    // at SUBMITTED. The poll must not re-flip it or enqueue a shipping email.
    const order = await seedSubmitted(tenant.id, { status: "FULFILLED" });

    const shipped = await orderRepository.markShipped(
      tenant.id,
      order.id,
      TRACKING,
    );
    expect(shipped).toBe(false);
    expect(await outboxFor(order.id)).toHaveLength(0);
  });

  it("does not reconcile an order that isn't SUBMITTED (fulfillmentStatus guard)", async () => {
    const tenant = await freshTenant();
    const order = await seedSubmitted(tenant.id, {
      fulfillmentStatus: "NOT_SUBMITTED",
    });

    const shipped = await orderRepository.markShipped(
      tenant.id,
      order.id,
      TRACKING,
    );
    expect(shipped).toBe(false);

    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.fulfillmentStatus).toBe("NOT_SUBMITTED");
    expect(await outboxFor(order.id)).toHaveLength(0);
  });

  it("does not cross the tenant boundary — a foreign order is invisible", async () => {
    const owner = await freshTenant();
    const other = await freshTenant();
    const order = await seedSubmitted(owner.id);

    const shipped = await orderRepository.markShipped(
      other.id,
      order.id,
      TRACKING,
    );
    expect(shipped).toBe(false);

    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.status).toBe("PAID");
    expect(persisted.fulfillmentStatus).toBe("SUBMITTED");
    expect(await outboxFor(order.id)).toHaveLength(0);
  });

  it("reconciles exactly once under a concurrent double-poll (Promise.all)", async () => {
    const tenant = await freshTenant();
    const order = await seedSubmitted(tenant.id);

    // Two poll runs land at once (or a poll racing a manual reconcile). Row locking
    // on the guarded updateMany must let exactly one win — and enqueue exactly one
    // shipping-confirmation.
    const [a, b] = await Promise.all([
      orderRepository.markShipped(tenant.id, order.id, TRACKING),
      orderRepository.markShipped(tenant.id, order.id, TRACKING),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await outboxFor(order.id)).toHaveLength(1);

    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.status).toBe("FULFILLED");
    expect(persisted.fulfillmentStatus).toBe("SHIPPED");
  });
});

/**
 * `markFulfillmentFailedAfterSubmission` — the SUBMITTED → FAILED terminal exit the
 * poll cron drives when the provider cancels/fails an order AFTER submission (#151),
 * the other one-way door out of SUBMITTED beside `markShipped`. Its guarantees live
 * in the database: the `{status: PAID, fulfillmentStatus: SUBMITTED}`-guarded
 * `updateMany` is the idempotency point (a duplicate/racing poll is a no-op) AND the
 * money-safety guard (a concurrently refunded/manually-fulfilled order is untouched),
 * and it must flip ONLY `fulfillmentStatus` — leaving `Order.status` PAID and the real
 * external id intact. A mock can't exercise `updateMany` count semantics or row
 * locking, so these run against the same Postgres the app uses.
 */
describe("orderRepository.markFulfillmentFailedAfterSubmission (integration)", () => {
  /** Seed a submitted-and-paid order carrying a real external id — the poll's
   *  reconcilable state (as `markSubmitted` leaves it). */
  function seedSubmitted(
    tenantId: string,
    opts: { status?: OrderStatus; fulfillmentStatus?: FulfillmentStatus } = {},
  ) {
    return seedOrder(tenantId, {
      status: opts.status ?? "PAID",
      fulfillmentStatus: opts.fulfillmentStatus ?? "SUBMITTED",
      fulfillmentExternalId: uniqueId("ext"),
    });
  }

  it("flips SUBMITTED → FAILED, persists the provider status, and leaves status PAID + the external id intact", async () => {
    const tenant = await freshTenant();
    const order = await seedSubmitted(tenant.id);

    const failed = await orderRepository.markFulfillmentFailedAfterSubmission(
      tenant.id,
      order.id,
      "canceled",
    );
    expect(failed).toBe(true);

    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.fulfillmentStatus).toBe("FAILED");
    expect(persisted.fulfillmentProviderStatus).toBe("canceled");
    // Order.status stays PAID (an operator refund/re-order decision), and the real
    // external id is kept — a FAILED order is never polled, so it can't reach
    // getTracking again (unlike the create-time soft-reject's placeholder id).
    expect(persisted.status).toBe("PAID");
    expect(persisted.fulfillmentExternalId).toBe(order.fulfillmentExternalId);
    // No customer email: a provider cancellation is an operator concern, not a
    // shipping notification.
    expect(
      await prisma.outboxMessage.count({ where: { orderId: order.id } }),
    ).toBe(0);
  });

  it("is idempotent — a duplicate poll fails once, then no-ops", async () => {
    const tenant = await freshTenant();
    const order = await seedSubmitted(tenant.id);

    const first = await orderRepository.markFulfillmentFailedAfterSubmission(
      tenant.id,
      order.id,
      "failed",
    );
    const second = await orderRepository.markFulfillmentFailedAfterSubmission(
      tenant.id,
      order.id,
      "failed",
    );
    expect(first).toBe(true);
    // Already FAILED → the guarded updateMany matches nothing on the second call.
    expect(second).toBe(false);
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
        .fulfillmentStatus,
    ).toBe("FAILED");
  });

  it("does not fail a REFUNDED order (status guard) — no flip", async () => {
    const tenant = await freshTenant();
    // A refund flipped `status` after submission, leaving `fulfillmentStatus` at
    // SUBMITTED. The status guard leaves it alone (it also drops from the poll via
    // findSubmittedForPolling's own `status: PAID` filter).
    const order = await seedSubmitted(tenant.id, { status: "REFUNDED" });

    const failed = await orderRepository.markFulfillmentFailedAfterSubmission(
      tenant.id,
      order.id,
      "canceled",
    );
    expect(failed).toBe(false);

    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.status).toBe("REFUNDED");
    expect(persisted.fulfillmentStatus).toBe("SUBMITTED");
    expect(persisted.fulfillmentProviderStatus).toBeNull();
  });

  it("does not fail a manually-FULFILLED order (status guard)", async () => {
    const tenant = await freshTenant();
    const order = await seedSubmitted(tenant.id, { status: "FULFILLED" });

    const failed = await orderRepository.markFulfillmentFailedAfterSubmission(
      tenant.id,
      order.id,
      "canceled",
    );
    expect(failed).toBe(false);
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
        .fulfillmentStatus,
    ).toBe("SUBMITTED");
  });

  it("does not regress an already-SHIPPED order (fulfillmentStatus guard)", async () => {
    const tenant = await freshTenant();
    // A shipment reconciled first (SHIPPED + FULFILLED); a late terminal-fail poll
    // must never undo it.
    const order = await seedSubmitted(tenant.id, {
      status: "FULFILLED",
      fulfillmentStatus: "SHIPPED",
    });

    const failed = await orderRepository.markFulfillmentFailedAfterSubmission(
      tenant.id,
      order.id,
      "canceled",
    );
    expect(failed).toBe(false);
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
        .fulfillmentStatus,
    ).toBe("SHIPPED");
  });

  it("does not cross the tenant boundary — a foreign order is invisible", async () => {
    const owner = await freshTenant();
    const other = await freshTenant();
    const order = await seedSubmitted(owner.id);

    const failed = await orderRepository.markFulfillmentFailedAfterSubmission(
      other.id,
      order.id,
      "canceled",
    );
    expect(failed).toBe(false);

    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.fulfillmentStatus).toBe("SUBMITTED");
    expect(persisted.fulfillmentProviderStatus).toBeNull();
  });

  it("fails exactly once under a concurrent double-poll (Promise.all)", async () => {
    const tenant = await freshTenant();
    const order = await seedSubmitted(tenant.id);

    // Two poll runs land at once: row locking on the guarded updateMany must let
    // exactly one make the transition.
    const [a, b] = await Promise.all([
      orderRepository.markFulfillmentFailedAfterSubmission(
        tenant.id,
        order.id,
        "canceled",
      ),
      orderRepository.markFulfillmentFailedAfterSubmission(
        tenant.id,
        order.id,
        "canceled",
      ),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
        .fulfillmentStatus,
    ).toBe("FAILED");
  });
});

/**
 * `markFulfillmentStuck` — the poll cron's "surface a stuck open shipment" write
 * (M4 #155), the deliberate INVERSE of `markFulfillmentFailedAfterSubmission` right
 * above: it stamps `fulfillmentStuckAt` and snapshots the raw provider status into
 * `fulfillmentProviderStatus` (admin display, #161) but does NOT terminalize —
 * `fulfillmentStatus` stays SUBMITTED and `status` stays PAID, because a provider hold
 * (`onhold`/`inreview`) can still ship. Its guarantees live in the database: the
 * `{status: PAID,
 * fulfillmentStatus: SUBMITTED, fulfillmentStuckAt: null}`-guarded `updateMany` is the
 * idempotency point (a duplicate/racing poll is a no-op) AND the money-safety guard (a
 * concurrently refunded/manually-fulfilled order is untouched). A mock can't exercise
 * `updateMany` count semantics or row locking, so these run against the same Postgres
 * the app uses.
 */
describe("orderRepository.markFulfillmentStuck (integration)", () => {
  /** Seed a submitted-and-paid order carrying a real external id — the poll's
   *  reconcilable state (as `markSubmitted` leaves it). */
  function seedSubmitted(
    tenantId: string,
    opts: { status?: OrderStatus; fulfillmentStatus?: FulfillmentStatus } = {},
  ) {
    return seedOrder(tenantId, {
      status: opts.status ?? "PAID",
      fulfillmentStatus: opts.fulfillmentStatus ?? "SUBMITTED",
      fulfillmentExternalId: uniqueId("ext"),
    });
  }

  it("stamps fulfillmentStuckAt and snapshots the provider status, leaving fulfillmentStatus SUBMITTED and status PAID untouched", async () => {
    const tenant = await freshTenant();
    const order = await seedSubmitted(tenant.id);
    expect(order.fulfillmentStuckAt).toBeNull();
    expect(order.fulfillmentProviderStatus).toBeNull();

    const flagged = await orderRepository.markFulfillmentStuck(
      tenant.id,
      order.id,
      "onhold",
    );
    expect(flagged).toBe(true);

    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.fulfillmentStuckAt).not.toBeNull();
    // The raw hold status is snapshotted for the admin view (#161)...
    expect(persisted.fulfillmentProviderStatus).toBe("onhold");
    // ...but deliberately the inverse of markFulfillmentFailedAfterSubmission on the
    // lifecycle: NOTHING else moves — a provider hold can still ship, so the order
    // must keep being polled rather than being terminalized.
    expect(persisted.fulfillmentStatus).toBe("SUBMITTED");
    expect(persisted.status).toBe("PAID");
  });

  it("is idempotent — a duplicate poll stamps once, then no-ops (snapshot not overwritten)", async () => {
    const tenant = await freshTenant();
    const order = await seedSubmitted(tenant.id);

    const first = await orderRepository.markFulfillmentStuck(
      tenant.id,
      order.id,
      "onhold",
    );
    const firstStamp = (
      await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    ).fulfillmentStuckAt;
    // A later poll reads a shifted hold status ("onhold" → "inreview"), but the
    // `fulfillmentStuckAt: null` guard makes the whole write a no-op — the snapshot is
    // one-shot at flag time, not refreshed each run (the #161 design decision).
    const second = await orderRepository.markFulfillmentStuck(
      tenant.id,
      order.id,
      "inreview",
    );

    expect(first).toBe(true);
    // Already stamped → the guarded updateMany matches nothing on the second call.
    expect(second).toBe(false);
    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.fulfillmentStuckAt).toEqual(firstStamp);
    // The shifted "inreview" was NOT written — the flag-time "onhold" snapshot stands.
    expect(persisted.fulfillmentProviderStatus).toBe("onhold");
  });

  it("does not stamp a REFUNDED order (status guard) — no write", async () => {
    const tenant = await freshTenant();
    // A refund flipped `status` after submission, leaving `fulfillmentStatus` at
    // SUBMITTED. The status guard leaves it alone (it also drops from the poll via
    // findSubmittedForPolling's own `status: PAID` filter).
    const order = await seedSubmitted(tenant.id, { status: "REFUNDED" });

    const flagged = await orderRepository.markFulfillmentStuck(
      tenant.id,
      order.id,
      "onhold",
    );
    expect(flagged).toBe(false);

    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.status).toBe("REFUNDED");
    expect(persisted.fulfillmentStatus).toBe("SUBMITTED");
    expect(persisted.fulfillmentStuckAt).toBeNull();
    // The guard blocks the whole write — no snapshot leaks onto a refunded order.
    expect(persisted.fulfillmentProviderStatus).toBeNull();
  });

  it("does not stamp an order that isn't SUBMITTED (fulfillmentStatus guard)", async () => {
    const tenant = await freshTenant();
    // Already reconciled to a shipment — a late stuck-check must never touch it.
    const order = await seedSubmitted(tenant.id, {
      status: "FULFILLED",
      fulfillmentStatus: "SHIPPED",
    });

    const flagged = await orderRepository.markFulfillmentStuck(
      tenant.id,
      order.id,
      "onhold",
    );
    expect(flagged).toBe(false);

    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.fulfillmentStatus).toBe("SHIPPED");
    expect(persisted.fulfillmentStuckAt).toBeNull();
    // Guard blocks the write, so no stale hold status clobbers a shipped order.
    expect(persisted.fulfillmentProviderStatus).toBeNull();
  });

  it("does not cross the tenant boundary — a foreign order is invisible", async () => {
    const owner = await freshTenant();
    const other = await freshTenant();
    const order = await seedSubmitted(owner.id);

    const flagged = await orderRepository.markFulfillmentStuck(
      other.id,
      order.id,
      "onhold",
    );
    expect(flagged).toBe(false);

    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.fulfillmentStuckAt).toBeNull();
    expect(persisted.fulfillmentStatus).toBe("SUBMITTED");
    expect(persisted.fulfillmentProviderStatus).toBeNull();
  });

  it("stamps exactly once under a concurrent double-poll (Promise.all)", async () => {
    const tenant = await freshTenant();
    const order = await seedSubmitted(tenant.id);

    // Two poll runs land at once: row locking on the guarded updateMany must let
    // exactly one make the transition.
    const [a, b] = await Promise.all([
      orderRepository.markFulfillmentStuck(tenant.id, order.id, "onhold"),
      orderRepository.markFulfillmentStuck(tenant.id, order.id, "onhold"),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(persisted.fulfillmentStuckAt).not.toBeNull();
    expect(persisted.fulfillmentProviderStatus).toBe("onhold");
  });
});

describe("orderRepository.listByTenant (integration)", () => {
  it("returns a tenant's orders newest-first with a total", async () => {
    const tenant = await freshTenant();
    const oldest = await seedOrder(tenant.id, {
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const newest = await seedOrder(tenant.id, {
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
    });
    const middle = await seedOrder(tenant.id, {
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
    });

    const page = await orderRepository.listByTenant(tenant.id, {
      page: 1,
      pageSize: 10,
    });

    expect(page.total).toBe(3);
    expect(page.orders.map((o) => o.id)).toEqual([
      newest.id,
      middle.id,
      oldest.id,
    ]);
  });

  it("filters by status and totals only the filtered rows", async () => {
    const tenant = await freshTenant();
    await seedOrder(tenant.id, { status: "PENDING" });
    const paidOld = await seedOrder(tenant.id, {
      status: "PAID",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const paidNew = await seedOrder(tenant.id, {
      status: "PAID",
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
    });

    const page = await orderRepository.listByTenant(tenant.id, {
      status: "PAID",
      page: 1,
      pageSize: 10,
    });

    expect(page.total).toBe(2);
    expect(page.orders.map((o) => o.id)).toEqual([paidNew.id, paidOld.id]);
    expect(page.orders.every((o) => o.status === "PAID")).toBe(true);
  });

  it("paginates — each page continues where the last left off", async () => {
    const tenant = await freshTenant();
    // Five orders with strictly increasing createdAt (so newest is last created).
    const dates = [
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
      "2026-01-05",
    ];
    const created: { id: string }[] = [];
    for (const d of dates) {
      created.push(
        await seedOrder(tenant.id, {
          createdAt: new Date(`${d}T00:00:00.000Z`),
        }),
      );
    }
    const newestFirst = [...created].reverse().map((o) => o.id);

    const p1 = await orderRepository.listByTenant(tenant.id, {
      page: 1,
      pageSize: 2,
    });
    const p2 = await orderRepository.listByTenant(tenant.id, {
      page: 2,
      pageSize: 2,
    });
    const p3 = await orderRepository.listByTenant(tenant.id, {
      page: 3,
      pageSize: 2,
    });

    expect(p1.total).toBe(5);
    expect(p1.orders.map((o) => o.id)).toEqual(newestFirst.slice(0, 2));
    expect(p2.orders.map((o) => o.id)).toEqual(newestFirst.slice(2, 4));
    expect(p3.orders.map((o) => o.id)).toEqual(newestFirst.slice(4, 5));
  });

  it("does not cross the tenant boundary — only the tenant's orders", async () => {
    const owner = await freshTenant();
    const other = await freshTenant();
    await seedOrder(owner.id, {});
    await seedOrder(owner.id, {});
    await seedOrder(other.id, {});

    const page = await orderRepository.listByTenant(owner.id, {
      page: 1,
      pageSize: 10,
    });
    expect(page.total).toBe(2);
    expect(page.orders.every((o) => o.tenantId === owner.id)).toBe(true);
  });
});

/**
 * `findStalePending` — the abandoned-checkout sweep's work list (#25). This is a
 * platform-wide query (it deliberately spans tenants, like the outbox drain), so
 * assertions filter to the ids each test created rather than asserting absolute
 * counts: the query may legitimately see other tenants' rows.
 */
describe("orderRepository.findStalePending (integration)", () => {
  const minsAgo = (n: number) => new Date(Date.now() - n * 60_000);

  it("returns PENDING orders older than the cutoff, across tenants, oldest first", async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    // Ages: a1 = 3h, b1 = 2h, a2 = 1h → oldest-first is [a1, b1, a2], spanning tenants.
    const a1 = await seedOrder(a.id, { createdAt: minsAgo(180) });
    const a2 = await seedOrder(a.id, { createdAt: minsAgo(60) });
    const b1 = await seedOrder(b.id, { createdAt: minsAgo(120) });

    const stale = await orderRepository.findStalePending(minsAgo(30), 100);

    const mineInOrder = stale
      .map((o) => o.id)
      .filter((id) => [a1.id, a2.id, b1.id].includes(id));
    expect(mineInOrder).toEqual([a1.id, b1.id, a2.id]);
  });

  it("excludes orders newer than the cutoff", async () => {
    const t = await freshTenant();
    const old = await seedOrder(t.id, { createdAt: minsAgo(120) });
    const fresh = await seedOrder(t.id, { createdAt: minsAgo(5) });

    const ids = (await orderRepository.findStalePending(minsAgo(60), 100)).map(
      (o) => o.id,
    );
    expect(ids).toContain(old.id);
    expect(ids).not.toContain(fresh.id);
  });

  it("excludes orders that are not PENDING", async () => {
    const t = await freshTenant();
    const pending = await seedOrder(t.id, {
      status: "PENDING",
      createdAt: minsAgo(120),
    });
    const paid = await seedOrder(t.id, {
      status: "PAID",
      createdAt: minsAgo(120),
    });
    const cancelled = await seedOrder(t.id, {
      status: "CANCELLED",
      createdAt: minsAgo(120),
    });

    const ids = (await orderRepository.findStalePending(minsAgo(30), 100)).map(
      (o) => o.id,
    );
    expect(ids).toContain(pending.id);
    expect(ids).not.toContain(paid.id);
    expect(ids).not.toContain(cancelled.id);
  });

  it("respects the batch limit", async () => {
    const t = await freshTenant();
    await seedOrder(t.id, { createdAt: minsAgo(180) });
    await seedOrder(t.id, { createdAt: minsAgo(150) });
    await seedOrder(t.id, { createdAt: minsAgo(120) });

    // take=2 with ≥2 stale rows in existence → exactly 2, whatever else is around.
    const stale = await orderRepository.findStalePending(minsAgo(30), 2);
    expect(stale).toHaveLength(2);
  });

  it("selects only the fields the sweep needs (id, tenantId, PaymentIntent)", async () => {
    const t = await freshTenant();
    const o = await seedOrder(t.id, {
      createdAt: minsAgo(120),
      stripePaymentIntentId: "pi_shape",
    });

    const found = (
      await orderRepository.findStalePending(minsAgo(30), 100)
    ).find((r) => r.id === o.id);
    expect(found).toBeDefined();
    expect(Object.keys(found!).sort()).toEqual([
      "id",
      "stripePaymentIntentId",
      "tenantId",
    ]);
    expect(found).toMatchObject({
      id: o.id,
      tenantId: t.id,
      stripePaymentIntentId: "pi_shape",
    });
  });
});

/**
 * `findSubmittedForPolling` — the poll-fulfillment cron's work list (#140). Like
 * `findStalePending`, this is a platform-wide query (it spans tenants), so
 * assertions filter to the ids each test created rather than asserting absolute
 * counts. Both filters (`status: PAID` and `fulfillmentStatus: SUBMITTED`) are the
 * ones the poll relies on to reconcile only genuinely open shipments.
 */
describe("orderRepository.findSubmittedForPolling (integration)", () => {
  const minsAgo = (n: number) => new Date(Date.now() - n * 60_000);

  /** Seed a SUBMITTED+PAID order (the reconcilable state), across tenants. */
  function seedSubmitted(
    tenantId: string,
    opts: { createdAt?: Date; externalId?: string } = {},
  ) {
    return seedOrder(tenantId, {
      status: "PAID",
      fulfillmentStatus: "SUBMITTED",
      fulfillmentExternalId: opts.externalId ?? uniqueId("ext"),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    });
  }

  it("returns SUBMITTED+PAID orders across tenants, oldest first", async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    // Ages: a1 = 3h, b1 = 2h, a2 = 1h → oldest-first is [a1, b1, a2], spanning tenants.
    const a1 = await seedSubmitted(a.id, { createdAt: minsAgo(180) });
    const a2 = await seedSubmitted(a.id, { createdAt: minsAgo(60) });
    const b1 = await seedSubmitted(b.id, { createdAt: minsAgo(120) });

    const open = await orderRepository.findSubmittedForPolling(100);

    const mineInOrder = open
      .map((o) => o.id)
      .filter((id) => [a1.id, a2.id, b1.id].includes(id));
    expect(mineInOrder).toEqual([a1.id, b1.id, a2.id]);
  });

  it("deprioritises flagged-stuck orders to the tail — not-yet-flagged first, then oldest-flagged (#158)", async () => {
    const t = await freshTenant();
    // Two not-yet-flagged (fulfillmentStuckAt = null) orders, and two flagged-stuck
    // ones whose `createdAt` is OLDER than both fresh orders — pre-#158 (oldest-first
    // only) the flagged pair would poll first every run and, if the hold never
    // resolves, starve the fresh orders. Flag order is the inverse of createdAt order
    // (stuckA is oldest-created but flagged most recently) to prove the tail sorts by
    // `fulfillmentStuckAt`, not `createdAt`.
    const freshOld = await seedSubmitted(t.id, { createdAt: minsAgo(200) });
    const freshNew = await seedSubmitted(t.id, { createdAt: minsAgo(100) });
    const stuckA = await seedSubmitted(t.id, { createdAt: minsAgo(500) });
    const stuckB = await seedSubmitted(t.id, { createdAt: minsAgo(400) });
    await prisma.order.update({
      where: { id: stuckA.id },
      data: { fulfillmentStuckAt: minsAgo(30) },
    });
    await prisma.order.update({
      where: { id: stuckB.id },
      data: { fulfillmentStuckAt: minsAgo(90) },
    });

    const mineInOrder = (await orderRepository.findSubmittedForPolling(100))
      .map((o) => o.id)
      .filter((id) =>
        [freshOld.id, freshNew.id, stuckA.id, stuckB.id].includes(id),
      );
    // Not-yet-flagged first (oldest createdAt first), THEN flagged-stuck (oldest
    // `fulfillmentStuckAt` first) — even though stuckA/stuckB were created first.
    expect(mineInOrder).toEqual([
      freshOld.id,
      freshNew.id,
      stuckB.id,
      stuckA.id,
    ]);
  });

  it("excludes orders whose fulfillmentStatus isn't SUBMITTED", async () => {
    const t = await freshTenant();
    const submitted = await seedSubmitted(t.id);
    const notSubmitted = await seedOrder(t.id, {
      status: "PAID",
      fulfillmentStatus: "NOT_SUBMITTED",
    });
    const shipped = await seedOrder(t.id, {
      status: "FULFILLED",
      fulfillmentStatus: "SHIPPED",
    });
    const failed = await seedOrder(t.id, {
      status: "PAID",
      fulfillmentStatus: "FAILED",
    });

    const ids = (await orderRepository.findSubmittedForPolling(100)).map(
      (o) => o.id,
    );
    expect(ids).toContain(submitted.id);
    expect(ids).not.toContain(notSubmitted.id);
    expect(ids).not.toContain(shipped.id);
    expect(ids).not.toContain(failed.id);
  });

  it("excludes a SUBMITTED order that is no longer PAID (refunded / cancelled)", async () => {
    const t = await freshTenant();
    // A refund flipped `status` after submission, leaving fulfillmentStatus at
    // SUBMITTED. The `status: PAID` filter keeps it out of the poll's work list, so
    // no provider call is wasted on an order `markShipped` would refuse.
    const refunded = await seedOrder(t.id, {
      status: "REFUNDED",
      fulfillmentStatus: "SUBMITTED",
      fulfillmentExternalId: uniqueId("ext"),
    });
    const paid = await seedSubmitted(t.id);

    const ids = (await orderRepository.findSubmittedForPolling(100)).map(
      (o) => o.id,
    );
    expect(ids).toContain(paid.id);
    expect(ids).not.toContain(refunded.id);
  });

  it("respects the batch limit", async () => {
    const t = await freshTenant();
    await seedSubmitted(t.id, { createdAt: minsAgo(180) });
    await seedSubmitted(t.id, { createdAt: minsAgo(150) });
    await seedSubmitted(t.id, { createdAt: minsAgo(120) });

    // take=2 with ≥2 open rows in existence → exactly 2, whatever else is around.
    const open = await orderRepository.findSubmittedForPolling(2);
    expect(open).toHaveLength(2);
  });

  it("selects only the fields the poll needs (id, tenantId, fulfillmentExternalId)", async () => {
    const t = await freshTenant();
    const o = await seedSubmitted(t.id, { externalId: "ext_shape" });

    const found = (await orderRepository.findSubmittedForPolling(100)).find(
      (r) => r.id === o.id,
    );
    expect(found).toBeDefined();
    // Widened for the stuck-open-shipment check (#155): `createdAt` (the age
    // anchor) + `fulfillmentStuckAt` (the already-surfaced marker) joined the
    // select alongside the original three fields.
    expect(Object.keys(found!).sort()).toEqual([
      "createdAt",
      "fulfillmentExternalId",
      "fulfillmentStuckAt",
      "id",
      "tenantId",
    ]);
    expect(found).toMatchObject({
      id: o.id,
      tenantId: t.id,
      fulfillmentExternalId: "ext_shape",
    });
  });
});

/**
 * `findReusablePendingCandidates` — the checkout dedupe read (#25). Tenant-scoped,
 * so exact-count assertions are safe (a fresh tenant sees only its own rows). The
 * equality filters (email, currency, total, window, status) are what the service
 * relies on to never reuse a stale-priced or foreign attempt.
 */
describe("orderRepository.findReusablePendingCandidates (integration)", () => {
  const EMAIL = "reuse-shopper@example.com";
  const recent = () => new Date(Date.now() - 60_000); // 1 min ago (inside window)
  // The default query is a *guest* read (`userId: null` + email) — the identity
  // arm the pre-#92 tests exercised. Authenticated reads pass `{ userId }` instead.
  const query = (tenantId: string) => ({
    tenantId,
    userId: null,
    email: EMAIL,
    totalCents: 3000,
    currency: "usd",
    createdAfter: new Date(Date.now() - 15 * 60_000),
    limit: 5,
  });
  // An *authenticated* read: keyed on the session-proven userId, carrying no email.
  const authQuery = (tenantId: string, userId: string) => ({
    tenantId,
    userId,
    totalCents: 3000,
    currency: "usd",
    createdAfter: new Date(Date.now() - 15 * 60_000),
    limit: 5,
  });

  it("returns matching recent PENDING orders with their items, newest first", async () => {
    const t = await freshTenant();
    const variant = await seedVariant(t.id, { stock: 10, priceCents: 1500 });
    const older = await seedOrder(t.id, {
      email: EMAIL,
      currency: "usd",
      totalCents: 3000,
      createdAt: new Date(Date.now() - 5 * 60_000),
      lines: [{ variantId: variant.id, qty: 2, priceCents: 1500 }],
    });
    const newer = await seedOrder(t.id, {
      email: EMAIL,
      currency: "usd",
      totalCents: 3000,
      createdAt: recent(),
      lines: [{ variantId: variant.id, qty: 2, priceCents: 1500 }],
    });

    const found = await orderRepository.findReusablePendingCandidates(
      query(t.id),
    );

    expect(found.map((o) => o.id)).toEqual([newer.id, older.id]);
    expect(found[0].items).toHaveLength(1);
    expect(found[0].items[0]).toMatchObject({
      variantId: variant.id,
      quantity: 2,
    });
  });

  it("excludes a different shopper email", async () => {
    const t = await freshTenant();
    await seedOrder(t.id, {
      email: "someone-else@example.com",
      currency: "usd",
      totalCents: 3000,
      createdAt: recent(),
    });
    expect(
      await orderRepository.findReusablePendingCandidates(query(t.id)),
    ).toHaveLength(0);
  });

  it("excludes a different currency", async () => {
    const t = await freshTenant();
    await seedOrder(t.id, {
      email: EMAIL,
      currency: "eur",
      totalCents: 3000,
      createdAt: recent(),
    });
    expect(
      await orderRepository.findReusablePendingCandidates(query(t.id)),
    ).toHaveLength(0);
  });

  it("excludes a drifted total (a stale-priced prior attempt)", async () => {
    const t = await freshTenant();
    await seedOrder(t.id, {
      email: EMAIL,
      currency: "usd",
      totalCents: 2500,
      createdAt: recent(),
    });
    expect(
      await orderRepository.findReusablePendingCandidates(query(t.id)),
    ).toHaveLength(0);
  });

  it("excludes a non-PENDING order", async () => {
    const t = await freshTenant();
    await seedOrder(t.id, {
      status: "PAID",
      email: EMAIL,
      currency: "usd",
      totalCents: 3000,
      createdAt: recent(),
    });
    expect(
      await orderRepository.findReusablePendingCandidates(query(t.id)),
    ).toHaveLength(0);
  });

  it("excludes an order older than the reuse window", async () => {
    const t = await freshTenant();
    await seedOrder(t.id, {
      email: EMAIL,
      currency: "usd",
      totalCents: 3000,
      createdAt: new Date(Date.now() - 30 * 60_000), // 30 min > 15 min window
    });
    expect(
      await orderRepository.findReusablePendingCandidates(query(t.id)),
    ).toHaveLength(0);
  });

  it("excludes another tenant's order", async () => {
    const t = await freshTenant();
    const other = await freshTenant();
    await seedOrder(other.id, {
      email: EMAIL,
      currency: "usd",
      totalCents: 3000,
      createdAt: recent(),
    });
    expect(
      await orderRepository.findReusablePendingCandidates(query(t.id)),
    ).toHaveLength(0);
  });

  it("respects the candidate limit", async () => {
    const t = await freshTenant();
    for (let i = 0; i < 4; i++) {
      await seedOrder(t.id, {
        email: EMAIL,
        currency: "usd",
        totalCents: 3000,
        createdAt: new Date(Date.now() - (i + 1) * 60_000),
      });
    }
    const found = await orderRepository.findReusablePendingCandidates({
      ...query(t.id),
      limit: 2,
    });
    expect(found).toHaveLength(2);
  });

  // --- Identity binding (#92) -------------------------------------------------
  // The reuse read closes a guest-checkout hole: a client-supplied email must not
  // hand back a signed-in shopper's in-flight PaymentIntent. Authenticated reuse
  // binds to the session-proven userId; guest reuse is pinned to userId:null.

  it("matches an authenticated shopper on userId, ignoring the order's email (#92)", async () => {
    const t = await freshTenant();
    const shopper = await freshUser();
    const variant = await seedVariant(t.id, { stock: 10, priceCents: 1500 });
    const o = await seedOrder(t.id, {
      userId: shopper.id,
      // Whatever email happened to be on the order — an authenticated read never
      // filters on it, so it must not affect the match.
      email: "typed-something-else@example.com",
      currency: "usd",
      totalCents: 3000,
      createdAt: recent(),
      lines: [{ variantId: variant.id, qty: 2, priceCents: 1500 }],
    });

    const found = await orderRepository.findReusablePendingCandidates(
      authQuery(t.id, shopper.id),
    );

    expect(found.map((x) => x.id)).toEqual([o.id]);
    expect(found[0].items).toHaveLength(1);
  });

  it("never lets a guest email match a signed-in shopper's in-flight order (#92)", async () => {
    const t = await freshTenant();
    const victim = await freshUser();
    // Alice (signed in) has a PENDING order; an attacker knows her email + cart.
    await seedOrder(t.id, {
      userId: victim.id,
      email: EMAIL,
      currency: "usd",
      totalCents: 3000,
      createdAt: recent(),
    });

    // A GUEST checkout with Alice's email + identical cart total. The guest read is
    // pinned to userId:null, so Alice's userId-bound order is invisible — the exact
    // hole #92 closes (pre-fix, this returned her order + its client secret).
    expect(
      await orderRepository.findReusablePendingCandidates(query(t.id)),
    ).toHaveLength(0);
  });

  it("does not match a different signed-in shopper's order (#92)", async () => {
    const t = await freshTenant();
    const alice = await freshUser();
    const bob = await freshUser();
    await seedOrder(t.id, {
      userId: alice.id,
      email: EMAIL,
      currency: "usd",
      totalCents: 3000,
      createdAt: recent(),
    });

    // Bob's authenticated read must not pick up Alice's order.
    expect(
      await orderRepository.findReusablePendingCandidates(
        authQuery(t.id, bob.id),
      ),
    ).toHaveLength(0);
  });

  it("an authenticated read does not pick up a guest (userId-null) order (#92)", async () => {
    const t = await freshTenant();
    const shopper = await freshUser();
    // A guest order (userId null) with an otherwise-matching email/total/currency.
    await seedOrder(t.id, {
      userId: null,
      email: EMAIL,
      currency: "usd",
      totalCents: 3000,
      createdAt: recent(),
    });

    expect(
      await orderRepository.findReusablePendingCandidates(
        authQuery(t.id, shopper.id),
      ),
    ).toHaveLength(0);
  });
});

/**
 * `listByTenantAndUser` — the storefront account order history (#104). The
 * guarantee is isolation: the read is scoped by BOTH `tenantId` AND the
 * session-proven `userId`, so a shopper sees only their own orders — never
 * another shopper's, never a guest's, and never their own order placed on a
 * different store. Same offset pagination + newest-first ordering as the admin
 * `listByTenant`.
 */
describe("orderRepository.listByTenantAndUser (integration)", () => {
  it("returns only the shopper's own orders within the tenant, newest-first, with a total", async () => {
    const tenant = await freshTenant();
    const alice = await freshUser();
    const bob = await freshUser();
    const aliceOld = await seedOrder(tenant.id, {
      userId: alice.id,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const aliceNew = await seedOrder(tenant.id, {
      userId: alice.id,
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    // Bob's order in the same store must never appear in Alice's history.
    const bobOrder = await seedOrder(tenant.id, { userId: bob.id });

    const page = await orderRepository.listByTenantAndUser(
      tenant.id,
      alice.id,
      {
        page: 1,
        pageSize: 10,
      },
    );

    expect(page.total).toBe(2);
    expect(page.orders.map((o) => o.id)).toEqual([aliceNew.id, aliceOld.id]);
    expect(page.orders.map((o) => o.id)).not.toContain(bobOrder.id);
  });

  it("excludes guest (userId-null) orders", async () => {
    const tenant = await freshTenant();
    const alice = await freshUser();
    await seedOrder(tenant.id, { userId: alice.id });
    // A guest checkout in the same store carries userId null — not Alice's.
    await seedOrder(tenant.id, { userId: null });

    const page = await orderRepository.listByTenantAndUser(
      tenant.id,
      alice.id,
      {
        page: 1,
        pageSize: 10,
      },
    );

    expect(page.total).toBe(1);
    expect(page.orders.every((o) => o.userId === alice.id)).toBe(true);
  });

  it("does not cross the tenant boundary — the same shopper's order on another store is excluded", async () => {
    const storeA = await freshTenant();
    const storeB = await freshTenant();
    // One global shopper who has shopped at both stores.
    const alice = await freshUser();
    const atA = await seedOrder(storeA.id, { userId: alice.id });
    await seedOrder(storeB.id, { userId: alice.id });

    const page = await orderRepository.listByTenantAndUser(
      storeA.id,
      alice.id,
      {
        page: 1,
        pageSize: 10,
      },
    );

    // Scoped by tenant too: only the order placed on store A, never store B's.
    expect(page.total).toBe(1);
    expect(page.orders.map((o) => o.id)).toEqual([atA.id]);
  });

  it("paginates — each page continues where the last left off", async () => {
    const tenant = await freshTenant();
    const alice = await freshUser();
    const dates = [
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
      "2026-01-05",
    ];
    const created: { id: string }[] = [];
    for (const d of dates) {
      created.push(
        await seedOrder(tenant.id, {
          userId: alice.id,
          createdAt: new Date(`${d}T00:00:00.000Z`),
        }),
      );
    }
    const newestFirst = [...created].reverse().map((o) => o.id);

    const p1 = await orderRepository.listByTenantAndUser(tenant.id, alice.id, {
      page: 1,
      pageSize: 2,
    });
    const p2 = await orderRepository.listByTenantAndUser(tenant.id, alice.id, {
      page: 2,
      pageSize: 2,
    });
    const p3 = await orderRepository.listByTenantAndUser(tenant.id, alice.id, {
      page: 3,
      pageSize: 2,
    });

    expect(p1.total).toBe(5);
    expect(p1.orders.map((o) => o.id)).toEqual(newestFirst.slice(0, 2));
    expect(p2.orders.map((o) => o.id)).toEqual(newestFirst.slice(2, 4));
    expect(p3.orders.map((o) => o.id)).toEqual(newestFirst.slice(4, 5));
  });
});

/**
 * `findByIdForTenantAndUser` — the storefront order detail read (#104). The
 * security-critical guarantee: with `userId` in the WHERE alongside `tenantId`,
 * a shopper can open ONLY their own order — another shopper's id (even in the
 * same store), a guest order, or an order on a different store all resolve to
 * null, and the page renders a real 404. This is why the issue forbids reusing
 * the tenant-only `findByIdForTenant`, which would leak across shoppers.
 */
describe("orderRepository.findByIdForTenantAndUser (integration)", () => {
  it("returns the shopper's own order with its items", async () => {
    const tenant = await freshTenant();
    const alice = await freshUser();
    const variant = await seedVariant(tenant.id, {
      stock: 10,
      priceCents: 1500,
    });
    const order = await seedOrder(tenant.id, {
      userId: alice.id,
      lines: [{ variantId: variant.id, qty: 2, priceCents: 1500 }],
    });

    const found = await orderRepository.findByIdForTenantAndUser(
      tenant.id,
      alice.id,
      order.id,
    );

    expect(found?.id).toBe(order.id);
    expect(found?.items).toHaveLength(1);
    expect(found?.items[0]).toMatchObject({
      variantId: variant.id,
      quantity: 2,
    });
  });

  it("returns null for another shopper's order in the same tenant (no cross-shopper leak)", async () => {
    const tenant = await freshTenant();
    const alice = await freshUser();
    const bob = await freshUser();
    const bobOrder = await seedOrder(tenant.id, { userId: bob.id });

    // Alice guessing/altering the id to Bob's order must get nothing back — the
    // core acceptance criterion of #104.
    const found = await orderRepository.findByIdForTenantAndUser(
      tenant.id,
      alice.id,
      bobOrder.id,
    );
    expect(found).toBeNull();
  });

  it("returns null for a guest (userId-null) order", async () => {
    const tenant = await freshTenant();
    const alice = await freshUser();
    const guestOrder = await seedOrder(tenant.id, { userId: null });

    const found = await orderRepository.findByIdForTenantAndUser(
      tenant.id,
      alice.id,
      guestOrder.id,
    );
    expect(found).toBeNull();
  });

  it("does not cross the tenant boundary — a foreign store's order is invisible", async () => {
    const storeA = await freshTenant();
    const storeB = await freshTenant();
    const alice = await freshUser();
    // Alice's own order, but placed on store B.
    const atB = await seedOrder(storeB.id, { userId: alice.id });

    // Reading it under store A's scope (with Alice's id) must resolve to null.
    const found = await orderRepository.findByIdForTenantAndUser(
      storeA.id,
      alice.id,
      atB.id,
    );
    expect(found).toBeNull();
  });
});

/**
 * The order-level fulfillment-submission guards (M4 #139) — the SECOND idempotency
 * layer behind provider submission. Their guarantees live in the database's row
 * lock + status-guarded `updateMany`, not the code, so (like `markPaid`) they can
 * only be proven against real Postgres: exactly one of two racing submissions
 * claims the order, a lost worker's order stays stuck in SUBMITTING (never
 * re-submitted), and the terminal writes are guarded against regression. A
 * duplicate POD order is real money + a physical shipment, so this is the crux of
 * #139.
 */
describe("orderRepository fulfillment submission guards (integration)", () => {
  const readFulfillment = (id: string) =>
    prisma.order.findUniqueOrThrow({ where: { id } });

  it("claimForSubmission moves NOT_SUBMITTED → SUBMITTING and returns true", async () => {
    const tenant = await freshTenant();
    const order = await seedOrder(tenant.id, { status: "PAID" }); // NOT_SUBMITTED

    expect(await orderRepository.claimForSubmission(tenant.id, order.id)).toBe(
      true,
    );
    expect((await readFulfillment(order.id)).fulfillmentStatus).toBe(
      "SUBMITTING",
    );
  });

  it("is won by exactly one of two racing claims — so exactly one createOrder (Promise.all)", async () => {
    const tenant = await freshTenant();
    const order = await seedOrder(tenant.id, { status: "PAID" });

    // Two submissions land at once (an immediate dispatch racing the cron, or two
    // cron runs after a stale-claim recovery). Row locking on the guarded
    // `updateMany({ fulfillmentStatus: NOT_SUBMITTED })` must let exactly one flip
    // to SUBMITTING — only that winner would call provider.createOrder. Never both.
    const [a, b] = await Promise.all([
      orderRepository.claimForSubmission(tenant.id, order.id),
      orderRepository.claimForSubmission(tenant.id, order.id),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await readFulfillment(order.id)).fulfillmentStatus).toBe(
      "SUBMITTING",
    );
  });

  it("returns false for an order stuck in SUBMITTING — the lost-worker path is never re-submitted", async () => {
    const tenant = await freshTenant();
    // A lost worker left the order SUBMITTING: createOrder may have reached the
    // provider, but the SUBMITTED write never landed. A re-drain must NOT resubmit.
    const order = await seedOrder(tenant.id, {
      status: "PAID",
      fulfillmentStatus: "SUBMITTING",
    });

    expect(await orderRepository.claimForSubmission(tenant.id, order.id)).toBe(
      false,
    );
    // Untouched — stuck in SUBMITTING for a human to reconcile.
    expect((await readFulfillment(order.id)).fulfillmentStatus).toBe(
      "SUBMITTING",
    );
  });

  it("returns false for an already-terminal (SUBMITTED) order", async () => {
    const tenant = await freshTenant();
    const order = await seedOrder(tenant.id, {
      status: "PAID",
      fulfillmentStatus: "SUBMITTED",
    });

    expect(await orderRepository.claimForSubmission(tenant.id, order.id)).toBe(
      false,
    );
    expect((await readFulfillment(order.id)).fulfillmentStatus).toBe(
      "SUBMITTED",
    );
  });

  it("returns false for a REFUNDED order — a refunded order is never submitted", async () => {
    const tenant = await freshTenant();
    // A refund landed after PAID: `markRefundedByPaymentIntent` flips only `status`,
    // leaving fulfillmentStatus NOT_SUBMITTED and the queued fs_ message pending.
    // The claim's `status: PAID` guard must refuse it — otherwise we'd ship an order
    // the customer was already refunded (real money + a physical shipment).
    const order = await seedOrder(tenant.id, {
      status: "REFUNDED",
      fulfillmentStatus: "NOT_SUBMITTED",
    });

    expect(await orderRepository.claimForSubmission(tenant.id, order.id)).toBe(
      false,
    );
    expect((await readFulfillment(order.id)).fulfillmentStatus).toBe(
      "NOT_SUBMITTED",
    );
  });

  it("returns false for a manually-FULFILLED order — no provider double-fulfilment", async () => {
    const tenant = await freshTenant();
    // An admin hand-attested FULFILLED (`markFulfilled`) before the fs_ message
    // drained. Auto-submitting to the provider now would double-fulfil the order.
    const order = await seedOrder(tenant.id, {
      status: "FULFILLED",
      fulfillmentStatus: "NOT_SUBMITTED",
    });

    expect(await orderRepository.claimForSubmission(tenant.id, order.id)).toBe(
      false,
    );
    expect((await readFulfillment(order.id)).fulfillmentStatus).toBe(
      "NOT_SUBMITTED",
    );
  });

  it("claimForSubmission does not cross the tenant boundary — a foreign order is untouched", async () => {
    const owner = await freshTenant();
    const other = await freshTenant();
    const order = await seedOrder(owner.id, { status: "PAID" });

    expect(await orderRepository.claimForSubmission(other.id, order.id)).toBe(
      false,
    );
    expect((await readFulfillment(order.id)).fulfillmentStatus).toBe(
      "NOT_SUBMITTED",
    );
  });

  it("markSubmitted moves SUBMITTING → SUBMITTED and persists the external id + provider", async () => {
    const tenant = await freshTenant();
    const order = await seedOrder(tenant.id, {
      status: "PAID",
      fulfillmentStatus: "SUBMITTING",
    });

    expect(
      await orderRepository.markSubmitted(
        tenant.id,
        order.id,
        "pf_12345",
        "printful",
      ),
    ).toBe(true);

    expect(await readFulfillment(order.id)).toMatchObject({
      fulfillmentStatus: "SUBMITTED",
      fulfillmentExternalId: "pf_12345",
      fulfillmentProvider: "printful",
    });
  });

  it("markSubmitted no-ops on a non-SUBMITTING order (guarded — no external id leak)", async () => {
    const tenant = await freshTenant();
    const order = await seedOrder(tenant.id, { status: "PAID" }); // NOT_SUBMITTED

    expect(
      await orderRepository.markSubmitted(
        tenant.id,
        order.id,
        "pf_x",
        "printful",
      ),
    ).toBe(false);

    const persisted = await readFulfillment(order.id);
    expect(persisted.fulfillmentStatus).toBe("NOT_SUBMITTED");
    expect(persisted.fulfillmentExternalId).toBeNull();
    expect(persisted.fulfillmentProvider).toBeNull();
  });

  it("markFulfillmentFailed moves NOT_SUBMITTED → FAILED (a pre-claim permanent failure)", async () => {
    const tenant = await freshTenant();
    const order = await seedOrder(tenant.id, { status: "PAID" }); // NOT_SUBMITTED

    await orderRepository.markFulfillmentFailed(tenant.id, order.id);

    expect((await readFulfillment(order.id)).fulfillmentStatus).toBe("FAILED");
  });

  it("markFulfillmentFailed moves SUBMITTING → FAILED (a soft rejection after the claim)", async () => {
    const tenant = await freshTenant();
    const order = await seedOrder(tenant.id, {
      status: "PAID",
      fulfillmentStatus: "SUBMITTING",
    });

    await orderRepository.markFulfillmentFailed(tenant.id, order.id);

    expect((await readFulfillment(order.id)).fulfillmentStatus).toBe("FAILED");
  });

  it("markFulfillmentFailed does not regress an already-SUBMITTED order", async () => {
    const tenant = await freshTenant();
    const order = await seedOrder(tenant.id, {
      status: "PAID",
      fulfillmentStatus: "SUBMITTED",
    });

    await orderRepository.markFulfillmentFailed(tenant.id, order.id);

    // The guard excludes SUBMITTED/SHIPPED — a stray late failure can't undo a
    // recorded success.
    expect((await readFulfillment(order.id)).fulfillmentStatus).toBe(
      "SUBMITTED",
    );
  });
});
