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
