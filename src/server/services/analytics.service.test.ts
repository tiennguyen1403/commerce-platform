import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Order } from "@prisma/client";
import { analyticsService } from "@/server/services/analytics.service";
import {
  analyticsRepository,
  type RevenueTimeSeriesRow,
  type VariantStockRow,
} from "@/server/repositories/analytics.repository";
import { orderService } from "@/server/services/order.service";
import { LOW_STOCK_THRESHOLD } from "@/config/constants";

/**
 * Unit tests for the admin dashboard's analytics service. Only the I/O
 * boundaries are mocked — the repository and the one service→service call
 * (`orderService.listOrders`) — so `availableUnits`, `LOW_STOCK_THRESHOLD`, and
 * `ORDER_STATUSES` run for real and these tests lock in the service's actual
 * low-stock math, threshold, and status-ordering behaviour, not a stand-in for
 * it. The service imports no logger, so none is stubbed here.
 */

vi.mock("@/server/repositories/analytics.repository", () => ({
  analyticsRepository: {
    revenueBreakdown: vi.fn(),
    orderCountsByStatus: vi.fn(),
    listActiveVariantStock: vi.fn(),
    revenueTimeSeries: vi.fn(),
  },
}));
vi.mock("@/server/services/order.service", () => ({
  orderService: { listOrders: vi.fn() },
}));

const revenueBreakdown = vi.mocked(analyticsRepository.revenueBreakdown);
const orderCountsByStatus = vi.mocked(analyticsRepository.orderCountsByStatus);
const listActiveVariantStock = vi.mocked(
  analyticsRepository.listActiveVariantStock,
);
const revenueTimeSeries = vi.mocked(analyticsRepository.revenueTimeSeries);
const listOrders = vi.mocked(orderService.listOrders);

const TENANT = "tenant_1";

// Module-local in the service (not exported); duplicated here as the expected
// recent-orders page size / low-stock cap / trend-chart window length.
const RECENT_ORDERS_LIMIT = 5;
const LOW_STOCK_LIMIT = 5;
const ANALYTICS_WINDOW_DAYS = 30;

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
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    updatedAt: new Date("2025-01-01T00:00:00.000Z"),
    ...o,
  };
}

function variantStockRow(o: Partial<VariantStockRow> = {}): VariantStockRow {
  return {
    id: "variant_1",
    sku: "SKU-1",
    name: "Default",
    stock: 10,
    reserved: 0,
    productTitle: "Product",
    productId: "product",
    ...o,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  // Sane defaults so a test that only cares about one leg of the `Promise.all`
  // still resolves the other three (the service awaits all four together).
  revenueBreakdown.mockResolvedValue({
    grossCents: 0,
    refundedCents: 0,
    netCents: 0,
  });
  orderCountsByStatus.mockResolvedValue([]);
  listActiveVariantStock.mockResolvedValue([]);
  revenueTimeSeries.mockResolvedValue([]);
  listOrders.mockResolvedValue({ orders: [], total: 0 });
});

describe("analyticsService.getDashboard", () => {
  it("passes the repository's revenue breakdown through unchanged", async () => {
    const breakdown = {
      grossCents: 123456,
      refundedCents: 23456,
      netCents: 100000,
    };
    revenueBreakdown.mockResolvedValue(breakdown);

    const summary = await analyticsService.getDashboard(TENANT);

    expect(summary.revenue).toEqual(breakdown);
  });

  it("backfills a partial status list to all 5, in ORDER_STATUSES order, and sums the total", async () => {
    orderCountsByStatus.mockResolvedValue([
      { status: "PAID", count: 3 },
      { status: "FULFILLED", count: 2 },
    ]);

    const summary = await analyticsService.getDashboard(TENANT);

    expect(summary.ordersByStatus).toEqual([
      { status: "PENDING", count: 0 },
      { status: "PAID", count: 3 },
      { status: "FULFILLED", count: 2 },
      { status: "CANCELLED", count: 0 },
      { status: "REFUNDED", count: 0 },
    ]);
    expect(summary.totalOrders).toBe(5);
  });

  it("zero-fills all 5 statuses and totals 0 when the repo returns no rows", async () => {
    orderCountsByStatus.mockResolvedValue([]);

    const summary = await analyticsService.getDashboard(TENANT);

    expect(summary.ordersByStatus).toEqual([
      { status: "PENDING", count: 0 },
      { status: "PAID", count: 0 },
      { status: "FULFILLED", count: 0 },
      { status: "CANCELLED", count: 0 },
      { status: "REFUNDED", count: 0 },
    ]);
    expect(summary.totalOrders).toBe(0);
  });

  it("filters out above-threshold variants, floors a reserved>stock row to zero, and returns the 5 most urgent low-stock variants sorted by available then title", async () => {
    const alpha = variantStockRow({
      id: "v_alpha",
      sku: "SKU-ALPHA",
      productTitle: "Alpha",
      productId: "alpha",
      stock: 2,
      reserved: 5, // reserved > stock: availableUnits floors this to 0
    });
    const charlie = variantStockRow({
      id: "v_charlie",
      sku: "SKU-CHARLIE",
      productTitle: "Charlie",
      productId: "charlie",
      stock: 0,
      reserved: 0, // available 0 — ties with alpha; "Alpha" < "Charlie" wins
    });
    const bravo = variantStockRow({
      id: "v_bravo",
      sku: "SKU-BRAVO",
      productTitle: "Bravo",
      productId: "bravo",
      stock: 3,
      reserved: 0, // available 3
    });
    const delta = variantStockRow({
      id: "v_delta",
      sku: "SKU-DELTA",
      productTitle: "Delta",
      productId: "delta",
      stock: 4,
      reserved: 0, // available 4
    });
    const echo = variantStockRow({
      id: "v_echo",
      sku: "SKU-ECHO",
      productTitle: "Echo",
      productId: "echo",
      stock: LOW_STOCK_THRESHOLD,
      reserved: 0, // available === threshold: at-or-below, included (boundary)
    });
    const golf = variantStockRow({
      id: "v_golf",
      sku: "SKU-GOLF",
      productTitle: "Golf",
      productId: "golf",
      stock: LOW_STOCK_THRESHOLD,
      reserved: 0, // ties with echo at the threshold AND is the 6th
      // low-stock row — loses the title tie-break, so it's the one the
      // LOW_STOCK_LIMIT cap drops either way.
    });
    const foxtrot = variantStockRow({
      id: "v_foxtrot",
      sku: "SKU-FOXTROT",
      productTitle: "Foxtrot",
      productId: "foxtrot",
      stock: LOW_STOCK_THRESHOLD + 1,
      reserved: 0, // available = threshold + 1: just above it, excluded
    });
    const zebra = variantStockRow({
      id: "v_zebra",
      sku: "SKU-ZEBRA",
      productTitle: "Zebra",
      productId: "zebra",
      stock: LOW_STOCK_THRESHOLD + 20,
      reserved: 0, // far above threshold, excluded
    });

    // Fed out of order on purpose — the service must do its own sorting, not
    // rely on the repository's row order.
    listActiveVariantStock.mockResolvedValue([
      zebra,
      golf,
      delta,
      alpha,
      foxtrot,
      echo,
      charlie,
      bravo,
    ]);

    const summary = await analyticsService.getDashboard(TENANT);

    expect(summary.lowStock).toEqual([
      { ...alpha, available: 0 },
      { ...charlie, available: 0 },
      { ...bravo, available: 3 },
      { ...delta, available: 4 },
      { ...echo, available: LOW_STOCK_THRESHOLD },
    ]);
    expect(summary.lowStock).toHaveLength(LOW_STOCK_LIMIT);
    // 6 variants are at/below the threshold (alpha, charlie, bravo, delta, echo,
    // golf); the display list caps at 5, but the count must report the true 6 —
    // this is the KPI-under-reporting bug the count field exists to prevent.
    expect(summary.lowStockCount).toBe(6);
  });

  it("returns an empty low-stock list when there are no active variants", async () => {
    listActiveVariantStock.mockResolvedValue([]);

    const summary = await analyticsService.getDashboard(TENANT);

    expect(summary.lowStock).toEqual([]);
    expect(summary.lowStockCount).toBe(0);
  });

  it("passes recentOrders through from orderService.listOrders, requesting page 1 at the recent-orders limit", async () => {
    const orders = [order({ id: "order_a" }), order({ id: "order_b" })];
    listOrders.mockResolvedValue({ orders, total: 2 });

    const summary = await analyticsService.getDashboard(TENANT);

    expect(summary.recentOrders).toEqual(orders);
    expect(listOrders).toHaveBeenCalledTimes(1);
    expect(listOrders).toHaveBeenCalledWith(TENANT, {
      page: 1,
      pageSize: RECENT_ORDERS_LIMIT,
    });
  });

  it("scopes every underlying read to the exact tenantId passed in, running all four concurrently", async () => {
    const tenantId = "tenant_xyz";

    await analyticsService.getDashboard(tenantId);

    // Each mock resolved exactly once with the caller's tenantId — proof the
    // Promise.all fan-out reaches all four reads (none skipped/short-circuited)
    // and none defaults to some other tenant.
    expect(revenueBreakdown).toHaveBeenCalledTimes(1);
    expect(revenueBreakdown).toHaveBeenCalledWith(tenantId);
    expect(orderCountsByStatus).toHaveBeenCalledTimes(1);
    expect(orderCountsByStatus).toHaveBeenCalledWith(tenantId);
    expect(listActiveVariantStock).toHaveBeenCalledTimes(1);
    expect(listActiveVariantStock).toHaveBeenCalledWith(tenantId);
    expect(listOrders).toHaveBeenCalledTimes(1);
    expect(listOrders).toHaveBeenCalledWith(tenantId, {
      page: 1,
      pageSize: RECENT_ORDERS_LIMIT,
    });
  });
});

describe("analyticsService.getRevenueTimeSeries", () => {
  // Freeze "now" so the generated UTC-day window is deterministic. 2026-09-03 (a
  // mid-day UTC instant) ⇒ a 30-day window of 2026-08-05 … 2026-09-03 inclusive.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T09:30:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function row(
    day: string,
    o: Partial<RevenueTimeSeriesRow> = {},
  ): RevenueTimeSeriesRow {
    return { day, orderCount: 0, grossCents: 0, refundedCents: 0, ...o };
  }

  it("returns one contiguous, oldest-first point per UTC day across the window", async () => {
    const points = await analyticsService.getRevenueTimeSeries(TENANT);

    expect(points).toHaveLength(ANALYTICS_WINDOW_DAYS);
    expect(points[0].date).toBe("2026-08-05");
    expect(points.at(-1)?.date).toBe("2026-09-03");
    // Every step is exactly one calendar day — no gaps, no repeats, ascending.
    for (let i = 1; i < points.length; i++) {
      const prev = Date.parse(`${points[i - 1].date}T00:00:00Z`);
      const curr = Date.parse(`${points[i].date}T00:00:00Z`);
      expect(curr - prev).toBe(86_400_000);
    }
  });

  it("asks the repository for `since` = UTC midnight, window − 1 days back", async () => {
    await analyticsService.getRevenueTimeSeries(TENANT);

    expect(revenueTimeSeries).toHaveBeenCalledTimes(1);
    expect(revenueTimeSeries).toHaveBeenCalledWith(
      TENANT,
      new Date("2026-08-05T00:00:00.000Z"),
    );
  });

  it("zero-fills every day when the tenant had no orders in the window", async () => {
    revenueTimeSeries.mockResolvedValue([]);

    const points = await analyticsService.getRevenueTimeSeries(TENANT);

    expect(points).toHaveLength(ANALYTICS_WINDOW_DAYS);
    expect(
      points.every(
        (p) =>
          p.grossCents === 0 &&
          p.refundedCents === 0 &&
          p.netCents === 0 &&
          p.orderCount === 0,
      ),
    ).toBe(true);
  });

  it("buckets each raw day, derives net = gross − refunded, and leaves the gaps zero-filled", async () => {
    revenueTimeSeries.mockResolvedValue([
      row("2026-08-10", { orderCount: 3, grossCents: 5000, refundedCents: 0 }),
      row("2026-09-03", {
        orderCount: 2,
        grossCents: 6000,
        refundedCents: 5000,
      }),
    ]);

    const points = await analyticsService.getRevenueTimeSeries(TENANT);
    const byDate = new Map(points.map((p) => [p.date, p]));

    expect(byDate.get("2026-08-10")).toEqual({
      date: "2026-08-10",
      grossCents: 5000,
      refundedCents: 0,
      netCents: 5000,
      orderCount: 3,
    });
    expect(byDate.get("2026-09-03")).toEqual({
      date: "2026-09-03",
      grossCents: 6000,
      refundedCents: 5000,
      netCents: 1000,
      orderCount: 2,
    });
    // A day the repository never returned is present and zeroed, not missing.
    expect(byDate.get("2026-08-11")).toEqual({
      date: "2026-08-11",
      grossCents: 0,
      refundedCents: 0,
      netCents: 0,
      orderCount: 0,
    });
  });

  it("honours a custom window length", async () => {
    const points = await analyticsService.getRevenueTimeSeries(TENANT, 7);

    expect(points).toHaveLength(7);
    expect(points[0].date).toBe("2026-08-28");
    expect(points.at(-1)?.date).toBe("2026-09-03");
    expect(revenueTimeSeries).toHaveBeenCalledWith(
      TENANT,
      new Date("2026-08-28T00:00:00.000Z"),
    );
  });
});
