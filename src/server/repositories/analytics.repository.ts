import "server-only";
import { type OrderStatus } from "@prisma/client";
import { prisma } from "@/server/db";

/**
 * Read-only data-access for the admin dashboard's analytics. Every method is
 * scoped by `tenantId` so a store's dashboard can only ever aggregate its own
 * catalog and orders. Services call repositories; routes and pages call
 * services — never Prisma directly. These are pure reads, so — unlike the order
 * and product repositories — there are no unique-constraint failures to
 * translate and the `Prisma` runtime import stays out.
 */

/** One active variant's stock line for the low-stock computation, flattened for
 *  the service: the variant's own fields plus its parent product's title/id.
 *  Declared standalone (not via `ReturnType<typeof analyticsRepository.…>`): a
 *  self-referential return type would collapse the whole repo object to `any`
 *  (TS7022/TS2456), the same trap noted on `order.repository`'s inferred reads. */
export type VariantStockRow = {
  id: string;
  sku: string;
  name: string;
  stock: number;
  reserved: number;
  productTitle: string;
  productId: string;
};

/** The tenant's revenue split three ways, all integer cents (#93):
 *  - `grossCents` — every captured order (PAID + FULFILLED + REFUNDED): money that
 *    was actually collected at the card, before any reversal.
 *  - `refundedCents` — fully-refunded orders (REFUNDED). M2/M3 support full refunds
 *    only, so a REFUNDED order's whole `totalCents` IS the refunded amount; the
 *    REFUND transition rewrites `status` alone and never the total
 *    (`order.repository.markRefundedByPaymentIntent`), so the sale's snapshot
 *    survives to be netted out here.
 *  - `netCents` — `grossCents − refundedCents`: revenue the store still holds. Equal
 *    to the PAID + FULFILLED sum (the single figure the dashboard reported before
 *    #93, when a refund dropped its whole order rather than being netted), but now
 *    derived so it can be surfaced *as* net alongside the gross it comes from. */
export type RevenueBreakdown = {
  grossCents: number;
  refundedCents: number;
  netCents: number;
};

/** One UTC day's revenue + order-count aggregates from `revenueTimeSeries`,
 *  straight off the `$queryRaw` (before the service zero-fills the missing days).
 *  Declared standalone for the same reason as `VariantStockRow` — a
 *  `ReturnType<typeof analyticsRepository.…>`-derived type would collapse the repo
 *  object to `any` (TS7022/TS2456). `day` is the `date_trunc('day')` bucket
 *  rendered as a `YYYY-MM-DD` string in SQL (see the method), so there is no
 *  `timestamp`→`Date` timezone round-trip to reason about; the cent figures come
 *  from `COALESCE(SUM(…), 0)::int`, so they are always real integers, never null. */
export type RevenueTimeSeriesRow = {
  day: string;
  orderCount: number;
  grossCents: number;
  refundedCents: number;
};

export const analyticsRepository = {
  /**
   * Revenue split into gross / refunds / net for the tenant (#93). One `groupBy`
   * sums `totalCents` per captured status: PENDING and CANCELLED never represent
   * collected money (a PENDING order was never charged; CANCELLED is only ever
   * reached from PENDING, before capture), so they're excluded by the `where`.
   * REFUNDED stays in — its snapshot is the refunded amount, netted below.
   *
   * `groupBy` omits empty groups, so a missing status contributes 0 via `sumFor`;
   * `_sum.totalCents` is otherwise a real integer (never null for a present
   * group). Sums raw `totalCents` under the single-currency-per-tenant invariant
   * (each order snapshots its own `currency`, always equal to the tenant's today)
   * — revisit if multi-currency ships and one tenant holds mixed currencies.
   */
  async revenueBreakdown(tenantId: string): Promise<RevenueBreakdown> {
    const rows = await prisma.order.groupBy({
      by: ["status"],
      where: { tenantId, status: { in: ["PAID", "FULFILLED", "REFUNDED"] } },
      _sum: { totalCents: true },
    });
    const sumFor = (status: OrderStatus) =>
      rows.find((row) => row.status === status)?._sum.totalCents ?? 0;
    const grossCents =
      sumFor("PAID") + sumFor("FULFILLED") + sumFor("REFUNDED");
    const refundedCents = sumFor("REFUNDED");
    // Net = gross − refunds (== PAID + FULFILLED). Derived from the same sums, so
    // the two figures can never drift and net is guaranteed ≤ gross.
    return { grossCents, refundedCents, netCents: grossCents - refundedCents };
  },

  /**
   * Revenue and order counts bucketed by UTC day for the tenant, from `since`
   * (inclusive) onward — the raw material for the analytics trend charts (#107).
   * One `$queryRaw` because Prisma's `groupBy` can't `date_trunc` a timestamp
   * into day buckets; the fixed tagged template binds only `tenantId` and `since`
   * (no dynamic SQL), so it stays a plain parameterised query like the raw reads
   * in `product.repository`.
   *
   * The status split mirrors `revenueBreakdown` EXACTLY — `grossCents` sums every
   * captured status (PAID + FULFILLED + REFUNDED), `refundedCents` sums REFUNDED —
   * so a day's figures and the all-time headline can never disagree. `orderCount`
   * is every order created that day regardless of status (a placed order counts as
   * volume even before capture). PENDING/CANCELLED contribute to the count but not
   * to the money, via the `FILTER` clauses.
   *
   * `createdAt` is a `timestamp` (no zone) holding Prisma's UTC value, so
   * `date_trunc('day', …)` needs no session-timezone reasoning; `to_char(…,
   * 'YYYY-MM-DD')` returns the bucket as a plain string, side-stepping any
   * `timestamp`→`Date` interpretation on the way back and giving the service a
   * ready-made join key. Returns ONE row per day that HAD at least one order
   * (gaps are absent, not zero — the service zero-fills the window), oldest first.
   * Every camelCase alias is double-quoted so Postgres doesn't fold it to
   * lowercase (which would read back `undefined`); counts/sums are `::int` so the
   * typed row is always an integer, never a `bigint`.
   */
  async revenueTimeSeries(
    tenantId: string,
    since: Date,
  ): Promise<RevenueTimeSeriesRow[]> {
    return prisma.$queryRaw<RevenueTimeSeriesRow[]>`
      SELECT
        to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS "day",
        count(*)::int AS "orderCount",
        COALESCE(
          sum("totalCents") FILTER (
            WHERE "status"::text IN ('PAID', 'FULFILLED', 'REFUNDED')
          ),
          0
        )::int AS "grossCents",
        COALESCE(
          sum("totalCents") FILTER (WHERE "status"::text = 'REFUNDED'),
          0
        )::int AS "refundedCents"
      FROM "Order"
      WHERE "tenantId" = ${tenantId} AND "createdAt" >= ${since}
      GROUP BY 1
      ORDER BY 1
    `;
  },

  /**
   * Order counts grouped by status for the tenant. `groupBy` returns ONLY the
   * statuses that have at least one order — empty groups are omitted — so the
   * service backfills the full status set (zero-filled) itself; do NOT backfill
   * here.
   */
  async orderCountsByStatus(
    tenantId: string,
  ): Promise<Array<{ status: OrderStatus; count: number }>> {
    const rows = await prisma.order.groupBy({
      by: ["status"],
      where: { tenantId },
      _count: true,
    });
    return rows.map((row) => ({ status: row.status, count: row._count }));
  },

  /**
   * Raw stock rows for the tenant's ACTIVE products only, scoped through the
   * Product relation (`ProductVariant` has no `tenantId` of its own — mirrors
   * `product.repository.findVariantsForTenant`). Returns EVERY active variant,
   * not just the low ones, and does NOT apply the low-stock threshold: the
   * service filters on `available = stock - reserved` in app code, because
   * Prisma's `where` can't compare two columns of the same row. A lean in-app
   * filter — fine at portfolio catalog sizes; revisit with a raw SQL
   * `stock - reserved <= threshold` query if the catalog grows large.
   */
  async listActiveVariantStock(tenantId: string): Promise<VariantStockRow[]> {
    const rows = await prisma.productVariant.findMany({
      where: { product: { tenantId, status: "ACTIVE" } },
      select: {
        id: true,
        sku: true,
        name: true,
        stock: true,
        reserved: true,
        product: { select: { id: true, title: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      sku: row.sku,
      name: row.name,
      stock: row.stock,
      reserved: row.reserved,
      productTitle: row.product.title,
      productId: row.product.id,
    }));
  },
};
