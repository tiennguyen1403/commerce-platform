import "server-only";
import type { Order } from "@prisma/client";
import {
  analyticsRepository,
  type RevenueBreakdown,
  type VariantStockRow,
} from "@/server/repositories/analytics.repository";
import { orderService } from "@/server/services/order.service";
import { availableUnits } from "@/lib/inventory";
import { LOW_STOCK_THRESHOLD } from "@/config/constants";
import { ORDER_STATUSES, type OrderStatusValue } from "@/lib/validators/orders";

/**
 * Admin dashboard analytics. Assembles the `/admin` overview from tenant-scoped
 * repository reads and one service→service call — the caller supplies the
 * `tenantId` (the service never resolves the tenant itself), matching the rest
 * of the service layer. Stays free of Prisma (repositories own that) and of zod
 * (the calling boundary validates input; the dashboard takes none). Read-only:
 * it aggregates and shapes, never writes.
 */

// Display limits for the two "latest / most urgent" lists — small on purpose, so
// the dashboard is a glanceable summary, not a second orders/products table.
const RECENT_ORDERS_LIMIT = 5;
const LOW_STOCK_LIMIT = 5;

// The trailing window, in whole UTC days (today included), the analytics trend
// charts cover. Module-local like the limits above — it's analytics-only; nothing
// else reads it. Bump it here to widen every trend chart at once.
const ANALYTICS_WINDOW_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Midnight UTC of the day `d` falls on. UTC has no DST, so day arithmetic on the
 *  returned value is exact millisecond stepping (`MS_PER_DAY`). */
function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

/** The `YYYY-MM-DD` UTC key for a date — the join key between the generated day
 *  axis and the repository's `to_char(…, 'YYYY-MM-DD')` buckets. */
function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** One status row for the "orders by status" breakdown. */
export type StatusCount = { status: OrderStatusValue; count: number };

/** A low-stock variant: its raw stock row plus the derived sellable count. */
export type LowStockVariant = VariantStockRow & { available: number };

/** Everything the `/admin` dashboard renders, in one tenant-scoped read. */
export type DashboardSummary = {
  /** Revenue split into gross (captured) / refunds / net (held) — integer cents.
   *  `netCents` is the figure to lead with (money still on hand); the gross it's
   *  netted from and the refunds subtracted give it context, so the headline can't
   *  be misread as gross sales (#93). */
  revenue: RevenueBreakdown;
  /** Total orders across every status. */
  totalOrders: number;
  /** All 5 statuses, in `ORDER_STATUSES` order, zero-filled. */
  ordersByStatus: StatusCount[];
  /** Variants at or below the low-stock threshold, most urgent first, capped at
   *  `LOW_STOCK_LIMIT` for display. */
  lowStock: LowStockVariant[];
  /** Total number of low-stock variants — the full count BEFORE the display cap,
   *  so the KPI reports the real figure even when `lowStock` is truncated. */
  lowStockCount: number;
  /** Newest orders, capped at `RECENT_ORDERS_LIMIT`. */
  recentOrders: Order[];
};

/** One UTC day on the analytics trend charts: the same gross / refunds / net
 *  split as the all-time headline (#93), plus the day's order count.
 *  `netCents === grossCents − refundedCents`. `date` is a `YYYY-MM-DD` UTC key. */
export type RevenueTimeSeriesPoint = {
  date: string;
  grossCents: number;
  refundedCents: number;
  netCents: number;
  orderCount: number;
};

export const analyticsService = {
  /**
   * Assemble the dashboard summary for a tenant. The four underlying reads are
   * independent, so they run concurrently. Recent orders come via
   * `orderService.listOrders` (service→service, matching order→cart), which
   * wraps the tenant-scoped `orderRepository.listByTenant`, so the dashboard
   * never reaches past the service layer.
   */
  async getDashboard(tenantId: string): Promise<DashboardSummary> {
    const [revenue, rawCounts, variantRows, ordersPage] = await Promise.all([
      analyticsRepository.revenueBreakdown(tenantId),
      analyticsRepository.orderCountsByStatus(tenantId),
      analyticsRepository.listActiveVariantStock(tenantId),
      orderService.listOrders(tenantId, {
        page: 1,
        pageSize: RECENT_ORDERS_LIMIT,
      }),
    ]);

    // Backfill: groupBy omits empty groups, so map over the canonical tuple to
    // guarantee all 5 statuses appear (zero-filled) and in a stable order.
    const countMap = new Map(rawCounts.map((row) => [row.status, row.count]));
    const ordersByStatus: StatusCount[] = ORDER_STATUSES.map((status) => ({
      status,
      count: countMap.get(status) ?? 0,
    }));
    const totalOrders = ordersByStatus.reduce((sum, row) => sum + row.count, 0);

    // Low stock: derive sellable units via the shared helper (never re-inline
    // `stock - reserved`), keep the at-or-below-threshold rows, and rank the most
    // urgent first (lowest available, then title for a stable, readable tie
    // break). Ranked in full here; the card renders a capped shortlist while the
    // KPI reads the full count — so it can't silently under-report at > cap.
    const lowStockRanked: LowStockVariant[] = variantRows
      .map((row) => ({ ...row, available: availableUnits(row) }))
      .filter((row) => row.available <= LOW_STOCK_THRESHOLD)
      .sort(
        (a, b) =>
          a.available - b.available ||
          a.productTitle.localeCompare(b.productTitle),
      );

    return {
      revenue,
      totalOrders,
      ordersByStatus,
      lowStock: lowStockRanked.slice(0, LOW_STOCK_LIMIT),
      lowStockCount: lowStockRanked.length,
      recentOrders: ordersPage.orders,
    };
  },

  /**
   * The tenant's revenue (gross / refunds / net) and order count per UTC day over
   * the trailing `days`-day window (today included), oldest day first — the data
   * behind the analytics trend charts (#107).
   *
   * The repository returns only days that HAD orders, so this zero-fills the
   * window: it generates every UTC day from `since` to today and looks each up in
   * a `Map` keyed by `YYYY-MM-DD` (the same backfill shape as `ordersByStatus`),
   * guaranteeing a continuous, fixed-length series — no gaps, no dependence on
   * which days happened to have sales. `netCents` is derived per day
   * (`gross − refunded`), matching `revenueBreakdown` so a day's net can never
   * drift from its parts. `since` is UTC midnight `days − 1` days back, so exactly
   * `days` points come out.
   */
  async getRevenueTimeSeries(
    tenantId: string,
    days: number = ANALYTICS_WINDOW_DAYS,
  ): Promise<RevenueTimeSeriesPoint[]> {
    const today = startOfUtcDay(new Date());
    const since = new Date(today.getTime() - (days - 1) * MS_PER_DAY);
    const rows = await analyticsRepository.revenueTimeSeries(tenantId, since);

    const byDay = new Map(rows.map((row) => [row.day, row]));
    const points: RevenueTimeSeriesPoint[] = [];
    for (let i = 0; i < days; i++) {
      const date = utcDayKey(new Date(since.getTime() + i * MS_PER_DAY));
      const row = byDay.get(date);
      const grossCents = row?.grossCents ?? 0;
      const refundedCents = row?.refundedCents ?? 0;
      points.push({
        date,
        grossCents,
        refundedCents,
        netCents: grossCents - refundedCents,
        orderCount: row?.orderCount ?? 0,
      });
    }
    return points;
  },
};
