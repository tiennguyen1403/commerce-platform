import { afterAll, afterEach, describe, expect, it } from "vitest";
import { orderRepository } from "@/server/repositories/order.repository";
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

afterEach(async () => {
  await Promise.all(tenantIds.splice(0).map(deleteTenantDeep));
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Seed a product with a single variant and return that variant. */
async function seedVariant(
  tenantId: string,
  opts: { stock: number; priceCents?: number; name?: string },
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

/** Seed a PENDING order carrying the given lines and PaymentIntent id. */
async function seedPendingOrder(
  tenantId: string,
  stripePaymentIntentId: string,
  lines: SeedLine[],
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
});
