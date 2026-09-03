import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { OrderStatus, ProductStatus } from "@prisma/client";
import { analyticsRepository } from "@/server/repositories/analytics.repository";
import {
  createTestTenant,
  deleteTenantDeep,
  prisma,
  uniqueId,
} from "@/test/integration-db";

/**
 * Integration tests for the analytics repository against a real Postgres. The
 * `aggregate`/`groupBy`/relation-scoped reads have no in-repo precedent, so these
 * prove three things a mocked unit test can't: `revenueBreakdown` sums exactly
 * the captured statuses into gross/refunds/net (not more, not fewer),
 * `orderCountsByStatus` really omits empty groups (the behaviour the service
 * backfills around), and `listActiveVariantStock` both filters on the Product
 * relation's `status` and is tenant-isolated.
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

/** Seed a bare order (no line items — irrelevant to these reads) at a given
 *  status/total for one tenant. Pass `createdAt` to pin the order to a specific
 *  instant (for the time-series bucketing tests); it defaults to now(). */
function seedOrder(
  tenantId: string,
  status: OrderStatus,
  totalCents: number,
  createdAt?: Date,
) {
  return prisma.order.create({
    data: {
      tenantId,
      orderNumber: uniqueId("order"),
      status,
      email: "shopper@example.com",
      totalCents,
      currency: "usd",
      ...(createdAt ? { createdAt } : {}),
    },
  });
}

type SeedVariant = {
  sku: string;
  name: string;
  stock: number;
  reserved: number;
};

/** Seed a product (default ACTIVE) with the given variants. */
function seedProductWithVariants(
  tenantId: string,
  variants: SeedVariant[],
  overrides: { title?: string; status?: ProductStatus } = {},
) {
  return prisma.product.create({
    data: {
      tenantId,
      title: overrides.title ?? "Tee",
      slug: uniqueId("product"),
      status: overrides.status ?? "ACTIVE",
      variants: {
        create: variants.map((v) => ({
          sku: v.sku,
          name: v.name,
          priceCents: 1000,
          stock: v.stock,
          reserved: v.reserved,
        })),
      },
    },
    include: { variants: true },
  });
}

describe("analyticsRepository.revenueBreakdown (integration)", () => {
  it("splits gross/refunds/net across the captured statuses, excluding PENDING/CANCELLED", async () => {
    const tenant = await freshTenant();
    await seedOrder(tenant.id, "PENDING", 1000); // never charged — excluded
    await seedOrder(tenant.id, "PAID", 2000);
    await seedOrder(tenant.id, "FULFILLED", 3000);
    await seedOrder(tenant.id, "CANCELLED", 4000); // pre-capture — excluded
    await seedOrder(tenant.id, "REFUNDED", 5000);

    const revenue = await analyticsRepository.revenueBreakdown(tenant.id);

    expect(revenue).toEqual({
      grossCents: 10000, // 2000 PAID + 3000 FULFILLED + 5000 REFUNDED
      refundedCents: 5000, // the whole REFUNDED order (full refunds only)
      netCents: 5000, // gross − refunds == PAID + FULFILLED
    });
  });

  it("returns all-zero (not null) for a tenant with no captured orders", async () => {
    const tenant = await freshTenant();
    await seedOrder(tenant.id, "PENDING", 1000);

    const revenue = await analyticsRepository.revenueBreakdown(tenant.id);

    expect(revenue).toEqual({ grossCents: 0, refundedCents: 0, netCents: 0 });
  });
});

describe("analyticsRepository.orderCountsByStatus (integration)", () => {
  it("returns correct per-status counts and omits statuses with no orders", async () => {
    const tenant = await freshTenant();
    await seedOrder(tenant.id, "PENDING", 1000);
    await seedOrder(tenant.id, "PENDING", 1000);
    await seedOrder(tenant.id, "PAID", 1000);
    await seedOrder(tenant.id, "FULFILLED", 1000);
    await seedOrder(tenant.id, "FULFILLED", 1000);
    await seedOrder(tenant.id, "FULFILLED", 1000);
    // No CANCELLED, no REFUNDED seeded for this tenant — groupBy must omit them.

    const counts = await analyticsRepository.orderCountsByStatus(tenant.id);
    const byStatus = new Map(counts.map((r) => [r.status, r.count]));

    expect(byStatus.get("PENDING")).toBe(2);
    expect(byStatus.get("PAID")).toBe(1);
    expect(byStatus.get("FULFILLED")).toBe(3);
    expect(byStatus.has("CANCELLED")).toBe(false);
    expect(byStatus.has("REFUNDED")).toBe(false);
    expect(counts).toHaveLength(3);
  });

  it("returns an empty array for a tenant with no orders at all", async () => {
    const tenant = await freshTenant();

    const counts = await analyticsRepository.orderCountsByStatus(tenant.id);

    expect(counts).toEqual([]);
  });
});

describe("analyticsRepository.listActiveVariantStock (integration)", () => {
  it("returns only variants of ACTIVE products, shaped with the parent product's title/id", async () => {
    const tenant = await freshTenant();
    const active = await seedProductWithVariants(
      tenant.id,
      [
        { sku: "ACT-1", name: "Small", stock: 10, reserved: 2 },
        { sku: "ACT-2", name: "Large", stock: 5, reserved: 0 },
      ],
      { title: "Active Tee", status: "ACTIVE" },
    );
    await seedProductWithVariants(
      tenant.id,
      [{ sku: "DRAFT-1", name: "Only", stock: 99, reserved: 0 }],
      { title: "Draft Tee", status: "DRAFT" },
    );
    await seedProductWithVariants(
      tenant.id,
      [{ sku: "ARCH-1", name: "Only", stock: 99, reserved: 0 }],
      { title: "Archived Tee", status: "ARCHIVED" },
    );

    const rows = await analyticsRepository.listActiveVariantStock(tenant.id);
    const bySku = new Map(rows.map((r) => [r.sku, r]));

    const small = active.variants.find((v) => v.sku === "ACT-1");
    const large = active.variants.find((v) => v.sku === "ACT-2");
    if (!small || !large) throw new Error("seed produced unexpected variants");

    expect(rows).toHaveLength(2);
    expect(bySku.get("ACT-1")).toEqual({
      id: small.id,
      sku: "ACT-1",
      name: "Small",
      stock: 10,
      reserved: 2,
      productTitle: "Active Tee",
      productId: active.id,
    });
    expect(bySku.get("ACT-2")).toEqual({
      id: large.id,
      sku: "ACT-2",
      name: "Large",
      stock: 5,
      reserved: 0,
      productTitle: "Active Tee",
      productId: active.id,
    });
    // DRAFT/ARCHIVED products' variants never show up, however low their stock.
    expect(bySku.has("DRAFT-1")).toBe(false);
    expect(bySku.has("ARCH-1")).toBe(false);
  });

  it("is tenant-isolated — never returns another tenant's variants", async () => {
    const tenantA = await freshTenant();
    const tenantB = await freshTenant();
    await seedProductWithVariants(
      tenantA.id,
      [{ sku: "A-1", name: "A", stock: 1, reserved: 0 }],
      { title: "Tenant A Product" },
    );
    await seedProductWithVariants(
      tenantB.id,
      [{ sku: "B-1", name: "B", stock: 1, reserved: 0 }],
      { title: "Tenant B Product" },
    );

    const rowsA = await analyticsRepository.listActiveVariantStock(tenantA.id);

    expect(rowsA).toHaveLength(1);
    expect(rowsA[0].sku).toBe("A-1");
    expect(rowsA.some((r) => r.sku === "B-1")).toBe(false);
  });
});

describe("analyticsRepository.revenueTimeSeries (integration)", () => {
  const since = new Date("2026-08-01T00:00:00.000Z");

  it("buckets orders by UTC day with the gross/refund split and counts, oldest first, excluding pre-window orders", async () => {
    const tenant = await freshTenant();

    // Before `since` — must be excluded from every bucket.
    await seedOrder(
      tenant.id,
      "PAID",
      9999,
      new Date("2026-07-20T12:00:00.000Z"),
    );

    // 2026-08-10 — two captured orders spread across the day (incl. one at the
    // last second, to prove UTC bucketing doesn't spill into the next day) plus a
    // PENDING one that counts as volume but contributes no money.
    await seedOrder(
      tenant.id,
      "PAID",
      2000,
      new Date("2026-08-10T00:00:00.000Z"),
    );
    await seedOrder(
      tenant.id,
      "FULFILLED",
      3000,
      new Date("2026-08-10T23:59:59.000Z"),
    );
    await seedOrder(
      tenant.id,
      "PENDING",
      1000,
      new Date("2026-08-10T14:00:00.000Z"),
    );

    // 2026-08-11 at the very first instant of the day — paired with 08-10's
    // last-second order above, this proves the midnight boundary splits the two
    // days apart (the bucket never bleeds backward across UTC midnight).
    await seedOrder(
      tenant.id,
      "PAID",
      1234,
      new Date("2026-08-11T00:00:00.000Z"),
    );

    // 2026-08-15 — a REFUNDED order (its total counts toward BOTH gross and
    // refunded) alongside a PAID one.
    await seedOrder(
      tenant.id,
      "REFUNDED",
      5000,
      new Date("2026-08-15T09:00:00.000Z"),
    );
    await seedOrder(
      tenant.id,
      "PAID",
      1000,
      new Date("2026-08-15T18:30:00.000Z"),
    );

    const rows = await analyticsRepository.revenueTimeSeries(tenant.id, since);
    const byDay = new Map(rows.map((r) => [r.day, r]));

    // Only the in-window days appear — gaps are absent at the repo level.
    expect(rows.map((r) => r.day)).toEqual([
      "2026-08-10",
      "2026-08-11",
      "2026-08-15",
    ]);
    expect(byDay.get("2026-08-10")).toEqual({
      day: "2026-08-10",
      orderCount: 3, // PAID + FULFILLED + PENDING
      grossCents: 5000, // 2000 + 3000 (PENDING contributes no money)
      refundedCents: 0,
    });
    // The 00:00:00Z order is its own day — not merged into 08-10's 23:59:59Z one.
    expect(byDay.get("2026-08-11")).toEqual({
      day: "2026-08-11",
      orderCount: 1,
      grossCents: 1234,
      refundedCents: 0,
    });
    expect(byDay.get("2026-08-15")).toEqual({
      day: "2026-08-15",
      orderCount: 2,
      grossCents: 6000, // 5000 REFUNDED + 1000 PAID
      refundedCents: 5000, // the whole REFUNDED order
    });
  });

  it("returns no rows for a tenant with no orders in the window", async () => {
    const tenant = await freshTenant();
    // An order exists, but before the window — so the window is empty.
    await seedOrder(
      tenant.id,
      "PAID",
      1000,
      new Date("2026-07-01T00:00:00.000Z"),
    );

    const rows = await analyticsRepository.revenueTimeSeries(tenant.id, since);

    expect(rows).toEqual([]);
  });

  it("is tenant-isolated — never aggregates another tenant's orders", async () => {
    const tenantA = await freshTenant();
    const tenantB = await freshTenant();
    await seedOrder(
      tenantA.id,
      "PAID",
      1000,
      new Date("2026-08-10T10:00:00.000Z"),
    );
    await seedOrder(
      tenantB.id,
      "PAID",
      8888,
      new Date("2026-08-10T10:00:00.000Z"),
    );

    const rows = await analyticsRepository.revenueTimeSeries(tenantA.id, since);

    expect(rows).toEqual([
      { day: "2026-08-10", orderCount: 1, grossCents: 1000, refundedCents: 0 },
    ]);
  });
});
