import "server-only";
import { Prisma, type Order, type OrderStatus } from "@prisma/client";
import { prisma } from "@/server/db";
import {
  OrderNumberTakenError,
  InsufficientStockError,
} from "@/server/order.errors";
import type { ShippingAddress } from "@/server/fulfillment/provider";

/**
 * Data-access for orders. Every method is scoped by `tenantId` so a store can
 * only ever touch its own orders. Services call repositories; routes and pages
 * call services — never Prisma directly. Unique-constraint failures are the
 * repository's to translate, so the Prisma import stays here.
 */

/** One line of an order to persist, already priced/snapshotted by the service. */
export type CreateOrderItemInput = {
  variantId: string;
  titleSnapshot: string;
  priceCents: number;
  quantity: number;
};

/** The fields the abandoned-PENDING sweep (#25) needs for one order: its id and
 *  tenant (to run the tenant-scoped cancel-and-release) plus the PaymentIntent to
 *  cancel at Stripe. `stripePaymentIntentId` is nullable to mirror the column,
 *  though every checkout order links one. */
export type StalePendingOrder = {
  id: string;
  tenantId: string;
  stripePaymentIntentId: string | null;
};

/** The fields the poll-fulfillment cron (M4 #140) needs to reconcile one open
 *  shipment: its id + tenant (for the tenant-scoped reconcile write) and the
 *  provider's own order id to call `getTracking` against. `fulfillmentExternalId`
 *  is nullable to mirror the column, but a SUBMITTED order always carries a real
 *  one (`markSubmitted` is its only writer, on the success path) — the poll skips
 *  the anomalous null rather than call the provider with an empty id.
 *
 *  `createdAt` + `fulfillmentStuckAt` feed the stuck-open-shipment check (M4 #155):
 *  `createdAt` is the age anchor — immutable, so age reads straight off the row (see the
 *  threshold constant in `fulfillment.service.ts` for why creation time, not submission
 *  time, is the anchor) — and `fulfillmentStuckAt` (null until the poll first surfaces the
 *  order as stuck) lets the poll skip re-alerting one it already flagged. Since #158
 *  `fulfillmentStuckAt` is also the batch's PRIMARY sort key (flagged rows sort to the
 *  tail so a never-resolving hold can't starve fresh orders — see `findSubmittedForPolling`),
 *  with `createdAt` the secondary (oldest-first within each group). */
export type SubmittedOrderForPolling = {
  id: string;
  tenantId: string;
  fulfillmentExternalId: string | null;
  createdAt: Date;
  fulfillmentStuckAt: Date | null;
};

/** Who a reuse read is on behalf of — the identity binding that closes #92. A
 *  discriminated union: an authenticated shopper passes `{ userId }` and is matched
 *  on that session-proven id alone; a guest passes `{ userId: null, email }` and is
 *  matched on email but pinned to guest (userId-null) orders, so a guest-supplied
 *  email can never match — and reuse — a signed-in shopper's order. The `email?:
 *  never` on the authenticated arm makes crossing the trust boundary a *type* error
 *  (a client-supplied email can't ride along on an authenticated match); the query
 *  builder also reads `email` only in the guest branch, so it's enforced at runtime
 *  too. */
export type ReusablePendingIdentity =
  { userId: string; email?: never } | { userId: null; email: string };

/** Query for reusable in-flight checkout candidates (the #25 dedupe read, identity-
 *  bound in #92). The equality filters — tenant, caller identity, currency, and
 *  re-priced total — are pushed to the DB; the remaining line-set match and the live
 *  PaymentIntent-status check stay in the service, which owns that business logic. */
export type ReusablePendingQuery = {
  tenantId: string;
  totalCents: number;
  currency: string;
  /** Lower bound on `createdAt` — the reuse window (a soon-to-be-swept order isn't
   *  worth reusing). */
  createdAfter: Date;
  limit: number;
} & ReusablePendingIdentity;

/** A full order to persist. The `id`, `orderNumber`, total, and per-item prices
 *  are all computed by the service (from a fresh variant read) — never the
 *  client. `id` is pre-generated so the linked PaymentIntent can carry it in
 *  metadata while the row is written with the PaymentIntent id in one write.
 *  `userId` links the order to a signed-in shopper (resolved server-side from
 *  the session, never client-supplied) or is null for a guest checkout. */
export type CreateOrderInput = {
  id: string;
  tenantId: string;
  orderNumber: string;
  email: string;
  /** The authenticated shopper's global `User` id, or null for a guest. */
  userId: string | null;
  /** The validated shipping destination, written onto the order in the SAME
   *  transaction as its creation (M4 #135). Field names mirror the
   *  `ShippingAddress` domain shape; mapped to the flat `ship*` columns below. */
  shippingAddress: ShippingAddress;
  totalCents: number;
  currency: string;
  stripePaymentIntentId: string;
  items: CreateOrderItemInput[];
};

/**
 * Map a `ShippingAddress` to the order's flat `ship*` columns (M4 #135). The
 * optional `line2`/`state` collapse an absent/blank value to `null` — the column
 * convention for "not provided" (a guest/legacy order has none) — rather than an
 * empty string. Required fields arrive already trimmed + non-empty from
 * `shippingAddressSchema`, the sole validation boundary. Shared by the create and
 * the reuse-path address update so the two can't drift.
 */
function shippingAddressColumns(address: ShippingAddress) {
  return {
    shipName: address.name,
    shipLine1: address.line1,
    shipLine2: address.line2?.trim() || null,
    shipCity: address.city,
    shipState: address.state?.trim() || null,
    shipPostalCode: address.postalCode,
    shipCountry: address.country,
  };
}

/**
 * Does this order carry a complete shipping address? Checks the same required
 * columns the fulfillment service narrows to a `ShippingAddress`
 * (name/line1/city/postalCode/country; line2/state are optional) — kept beside
 * `shippingAddressColumns` so the two views of the `ship*` columns can't drift.
 * Gates the `FULFILLMENT_SUBMISSION` enqueue in `markPaidByPaymentIntent` (M4
 * #139): a guest/legacy order with no address has nowhere to ship, so it never
 * attempts submission (a `FulfillmentAddressMissingError` would only fail it).
 */
function hasShippingAddressColumns(order: {
  shipName: string | null;
  shipLine1: string | null;
  shipCity: string | null;
  shipPostalCode: string | null;
  shipCountry: string | null;
}): boolean {
  return (
    !!order.shipName &&
    !!order.shipLine1 &&
    !!order.shipCity &&
    !!order.shipPostalCode &&
    !!order.shipCountry
  );
}

/** Translate the `[tenantId, orderNumber]` unique-constraint failure into a
 *  typed error the service can retry on; rethrow anything else untouched. */
function mapWriteError(err: unknown): never {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002"
  ) {
    const target = String(
      (err.meta as { target?: unknown } | undefined)?.target ?? "",
    );
    if (target.includes("orderNumber")) throw new OrderNumberTakenError();
  }
  throw err;
}

/** A paid order's line that couldn't be fully allocated from stock at capture
 *  time (an oversell): the units were sold but weren't on hand. Surfaced so the
 *  webhook can flag it for manual refund/review — never silently dropped. */
export type StockShortfall = {
  variantId: string;
  /** The line's snapshotted name, for a human-readable alert. */
  titleSnapshot: string;
  /** Units the paid order needs on this line. */
  ordered: number;
  /** Units actually on hand at capture — what the `stock >= qty` guard found
   *  too few of (the line's stock is left untouched, so this is that figure). */
  available: number;
};

/** Outcome of the atomic mark-paid + stock-allocation transaction.
 *  `transitioned: false` — nothing moved; `orderExisted` tells an already-processed
 *  order (true) apart from an unknown intent (false), sparing the caller a re-read.
 *  `transitioned: true` — this call made the PENDING → PAID transition, carrying
 *  the paid `order` (with items) and any `shortfalls` the decrement couldn't fill. */
export type MarkPaidResult =
  | { transitioned: false; orderExisted: boolean }
  | { transitioned: true; order: OrderWithItems; shortfalls: StockShortfall[] };

/**
 * The single global order in which every variant-touching loop (reserve,
 * allocate, release) locks rows. Two transactions that share variants then
 * always acquire those row locks in the same sequence, so Postgres can't catch
 * them in a lock cycle and deadlock-abort one. Sorting in JS (not relying on a
 * query's collation) makes that order identical across all three loops.
 */
function byVariantId(
  a: { variantId: string },
  b: { variantId: string },
): number {
  return a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0;
}

/**
 * Release the reservations a set of order lines hold, flooring each variant's
 * `reserved` at 0 (`GREATEST(reserved - qty, 0)`). Runs inside the caller's
 * transaction; lines ordered by `variantId` for the deadlock-avoidance above.
 * Best-effort by construction — an unguarded, tenant-scoped UPDATE that can't
 * fail on a row count, so a double-fire or counter drift simply no-ops at the
 * floor. The shared reservation-release primitive: used by the PAID reconcile
 * below, and by the CANCELLED transition (#56) and the abandoned-PENDING sweep
 * (#25) once those land.
 */
async function releaseReserved(
  tx: Prisma.TransactionClient,
  tenantId: string,
  items: Array<{ variantId: string; quantity: number }>,
): Promise<void> {
  for (const item of [...items].sort(byVariantId)) {
    // Parameterized tagged-template raw SQL (never `$executeRawUnsafe`): the
    // `${}` are bound params. Tenant-scoped through Product — a variant carries
    // no tenantId — so one store's release can never touch another's rows.
    await tx.$executeRaw`
      UPDATE "ProductVariant" AS v
      SET "reserved" = GREATEST(v."reserved" - ${item.quantity}, 0),
          "updatedAt" = NOW()
      FROM "Product" AS p
      WHERE v."id" = ${item.variantId}
        AND v."productId" = p."id"
        AND p."tenantId" = ${tenantId}
    `;
  }
}

/** Paginated, optionally status-filtered query over a tenant's orders (the admin
 *  orders list). `page` is 1-based; `pageSize` bounds the rows returned. */
export type ListOrdersParams = {
  status?: OrderStatus;
  page: number;
  pageSize: number;
};

/** Paginated query over a single shopper's own orders within a tenant — the
 *  storefront account order history (#104). `page` is 1-based; `pageSize` bounds
 *  the rows. No `status` filter: a shopper's list shows all their orders. */
export type ListUserOrdersParams = {
  page: number;
  pageSize: number;
};

/** One page of a tenant's orders (bare rows, newest first) plus `total` — the
 *  count matching the same filter, for the caller's page math. */
export type OrdersPage = {
  orders: Order[];
  total: number;
};

/**
 * Outcome of a guarded order transition (cancel / fulfil). `transitioned: true`
 * — this caller made the move. `transitioned: false` — nothing moved:
 * `currentStatus: null` means no such order for the tenant; a non-null status
 * means an order that existed but wasn't in the required source state (the
 * committed status, so the service can say precisely "can't do that — it's X").
 */
export type OrderTransitionResult =
  | { transitioned: true }
  | { transitioned: false; currentStatus: OrderStatus | null };

/** The reconciled shipment a poll persists onto an order (M4 #140): the carrier +
 *  tracking the provider reported, plus its raw status string (→
 *  `fulfillmentProviderStatus`, admin display only). `carrier`/`trackingUrl` are
 *  nullable — a shipment may carry a tracking number but no carrier or link — but a
 *  reconciliation only runs once a `trackingNumber` is present (the poll's
 *  provider-agnostic "shipped" signal), so that field is non-null. */
export type ShipmentReconciliation = {
  providerStatus: string;
  carrier: string | null;
  trackingNumber: string;
  trackingUrl: string | null;
};

export const orderRepository = {
  /**
   * Create a PENDING order and its line items, reserving inventory for each line
   * — all in one transaction, so an order never exists without both its items and
   * its inventory hold. Each line's `reserved` is bumped under an atomic guard
   * (`stock - reserved >= qty`); if any line can't be covered the whole
   * transaction rolls back with `InsufficientStockError` (no partial hold, no
   * orphan order). A duplicate `orderNumber` still surfaces as
   * `OrderNumberTakenError` for the service to retry — the retry re-runs the
   * transaction, so the rolled-back reservations are simply re-taken.
   *
   * Reserving BEFORE the insert is deliberate: it takes each variant's exclusive
   * row lock (in `variantId` order) up front, so the KEY-SHARE locks the nested
   * item inserts then take are already held. Every variant-locking path here
   * (this reserve, the PAID decrement, the release) uses `byVariantId`, so
   * concurrent checkouts and confirmations acquire locks in one global order and
   * can't deadlock.
   */
  async createWithItems(input: CreateOrderInput) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          for (const item of [...input.items].sort(byVariantId)) {
            // Atomic reserve guard. Parameterized tagged-template raw SQL (never
            // `$executeRawUnsafe`) because Prisma's query builder can't compare
            // two columns; the `${}` are bound params. Tenant-scoped through
            // Product (a variant has no tenantId). Zero rows affected = the
            // sellable units aren't there → roll the order back as a sold-out.
            const reserved = await tx.$executeRaw`
              UPDATE "ProductVariant" AS v
              SET "reserved" = v."reserved" + ${item.quantity},
                  "updatedAt" = NOW()
              FROM "Product" AS p
              WHERE v."id" = ${item.variantId}
                AND v."productId" = p."id"
                AND p."tenantId" = ${input.tenantId}
                AND v."stock" - v."reserved" >= ${item.quantity}
            `;
            if (reserved === 0) throw new InsufficientStockError();
          }

          return await tx.order.create({
            data: {
              id: input.id,
              tenantId: input.tenantId,
              orderNumber: input.orderNumber,
              status: "PENDING",
              email: input.email,
              // Null for a guest; a signed-in shopper's global `User` id
              // otherwise (server-resolved upstream, never from the client).
              userId: input.userId,
              // Shipping destination, flattened onto the order in this SAME
              // transaction (M4 #135) — no separate write, no order without it.
              ...shippingAddressColumns(input.shippingAddress),
              totalCents: input.totalCents,
              currency: input.currency,
              stripePaymentIntentId: input.stripePaymentIntentId,
              items: {
                create: input.items.map((item) => ({
                  variantId: item.variantId,
                  titleSnapshot: item.titleSnapshot,
                  priceCents: item.priceCents,
                  quantity: item.quantity,
                })),
              },
            },
          });
        },
        // Reserve loop (one guarded UPDATE per line) + the order insert run in one
        // interactive transaction; lift Prisma's 5s default so a large cart on a
        // high-latency managed Postgres can't time out mid-reserve (mirrors
        // markPaidByPaymentIntent / product updateWithVariants).
        { timeout: 15_000 },
      );
    } catch (err) {
      mapWriteError(err);
    }
  },

  /**
   * Overwrite a still-PENDING order's shipping address — the reuse-path (#25/#135)
   * companion to `createWithItems`. When a re-submit reuses an in-flight
   * PaymentIntent instead of minting a fresh order, the shopper may have edited
   * their address since it was first written, so the latest submitted address must
   * win rather than silently shipping to the stale one. Tenant- AND status-scoped
   * (`updateMany`, not `update` by bare id): only a PENDING order in this tenant is
   * touched, so a raced PAID/CANCELLED order — or a foreign one — is never
   * rewritten. Best-effort (no row-count assertion): if the order has already left
   * PENDING we deliberately leave a captured order's address exactly as it shipped.
   */
  async updateShippingAddressForPending(
    tenantId: string,
    orderId: string,
    address: ShippingAddress,
  ): Promise<void> {
    await prisma.order.updateMany({
      where: { id: orderId, tenantId, status: "PENDING" },
      data: shippingAddressColumns(address),
    });
  },

  /**
   * Look up an order by its Stripe PaymentIntent id, scoped to the tenant.
   * `findFirst` keeps the tenant in the WHERE so a PaymentIntent belonging to
   * another store resolves to null rather than leaking a row. Powers the
   * checkout success page (and, later, the webhook's PENDING → PAID lookup).
   */
  findByPaymentIntentForTenant(
    tenantId: string,
    stripePaymentIntentId: string,
  ) {
    return prisma.order.findFirst({
      where: { tenantId, stripePaymentIntentId },
      include: { items: true },
    });
  },

  /**
   * Look up an order by id, scoped to the tenant, with its items — the shape the
   * outbox drain (#30) re-reads to render the confirmation email. Tenant in the
   * WHERE (golden rule #1) so one store's drain can never render another's order.
   */
  findByIdForTenant(tenantId: string, id: string) {
    return prisma.order.findFirst({
      where: { tenantId, id },
      include: { items: true },
    });
  },

  /**
   * One of a shopper's orders by id, scoped to BOTH the tenant AND the
   * session-proven `userId`, with its line items — the storefront order detail
   * (#104). Deliberately NOT a reuse of the tenant-only `findByIdForTenant`:
   * scoping by `tenantId` alone would let a signed-in shopper open another
   * shopper's order in the same store by guessing or altering its id. With
   * `userId` in the WHERE a foreign (or guest, `userId: null`) order resolves to
   * null and the page renders a real 404. Return type left to inference like the
   * other `include: { items: true }` reads — annotating it `OrderWithItems` would
   * make `orderRepository`'s type reference a type derived from `orderRepository`
   * (a circular reference); the inferred shape is structurally `OrderWithItems`.
   */
  findByIdForTenantAndUser(tenantId: string, userId: string, id: string) {
    return prisma.order.findFirst({
      where: { tenantId, userId, id },
      include: { items: true },
    });
  },

  /**
   * An order, scoped to the tenant, with its line items each joined to the
   * fulfillment mapping on their variant (`sku` + `providerVariantId`) — the shape
   * the submission service (M4 #137) reads to build a provider
   * `CreateFulfillmentInput`. Tenant in the WHERE (golden rule #1) so one store can
   * never submit another's order. Only the two mapping fields are selected off the
   * variant (not the whole row) — the price/stock are snapshotted on the
   * `OrderItem` already; fulfillment needs just the sku→provider link. Return type
   * left to inference like the other `include` reads here (a `ReturnType`-derived
   * annotation would make `orderRepository` reference a type derived from itself, a
   * circular reference); its shape is captured by the `OrderForFulfillment` type
   * exported below.
   */
  findForFulfillment(tenantId: string, id: string) {
    return prisma.order.findFirst({
      where: { tenantId, id },
      include: {
        items: {
          include: {
            variant: { select: { sku: true, providerVariantId: true } },
          },
        },
      },
    });
  },

  /**
   * PENDING orders created before `olderThan`, oldest first, up to `limit` — the
   * abandoned-checkout sweep's work list (#25). Like the outbox drain's `findDue`,
   * this is a **platform-wide** cron query and deliberately spans all tenants — the
   * one intentional exception to golden rule #1's tenant scoping (see the outbox
   * repository's tenancy note). There is no leakage: each row carries its own
   * `tenantId`, and every write the sweep makes off these rows runs through the
   * tenant-scoped `cancelPendingAndRelease(order.tenantId, …)`. Selects only the
   * fields the sweep needs — never the whole row. Served by the `[status,
   * createdAt]` index (mirroring the outbox's `[status, nextAttemptAt]`).
   */
  findStalePending(
    olderThan: Date,
    limit: number,
  ): Promise<StalePendingOrder[]> {
    return prisma.order.findMany({
      where: { status: "PENDING", createdAt: { lt: olderThan } },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: { id: true, tenantId: true, stripePaymentIntentId: true },
    });
  },

  /**
   * Open shipments awaiting reconciliation — the poll-fulfillment cron's work list
   * (M4 #140): orders the provider has accepted (`fulfillmentStatus: SUBMITTED`)
   * that are still PAID, up to `limit`, oldest first. Like `findStalePending` and
   * the outbox drain, this is a **platform-wide** cron query and deliberately spans
   * every tenant — the intentional exception to golden rule #1. There is no leakage:
   * each row carries its own `tenantId`, and the reconcile write runs through the
   * tenant-scoped `markShipped(order.tenantId, …)`.
   *
   * Both filters matter. `status: "PAID"` excludes an order that left the paid state
   * after submission — a `refund.succeeded` or a manual FULFILLED both flip `status`
   * only, leaving `fulfillmentStatus` at SUBMITTED — so the poll never wastes a
   * provider call on an order its terminal writers would refuse anyway: both
   * `markShipped` (→ SHIPPED) and `markFulfillmentFailedAfterSubmission` (→ FAILED,
   * #151) guard on this exact `{status: PAID, fulfillmentStatus: SUBMITTED}` predicate,
   * so the poll's two exits out of SUBMITTED re-check this filter under the row lock.
   * SUBMITTED is a transient, low-cardinality state (an order ships or fails out of
   * it), served by the `[fulfillmentStatus, status]` index (#158, added once a hold
   * that never resolves — see the ordering below — could let the set grow). Selects
   * only the fields the poll needs — never the whole row.
   *
   * Ordering deprioritises a flagged-stuck order (M4 #158). A #155-flagged hold stays
   * SUBMITTED (it may still ship, so #155 alerts but keeps polling it); left oldest-
   * first it would sit at the FRONT of every batch forever — one wasted `getTracking`
   * per run and, once enough accumulate, crowding fresh orders out of the batch limit
   * / time budget, so their shipments never reconcile (the liveness problem #151's
   * terminal exit was built to avoid). `fulfillmentStuckAt` is null until the poll
   * first surfaces an order as stuck, so `nulls: "first"` floats every not-yet-flagged
   * order ahead of every flagged one — fresh orders always poll first — while flagged
   * rows fill the tail (oldest-flagged first). A flagged order is never dropped from the
   * work list (the predicate is unchanged — the #155 invariant: deprioritise, don't
   * drop), so it keeps polling and reconciles if its hold ships. (`fulfillmentStuckAt`
   * is write-once, so the tail order is stable across runs: a pathological backlog of
   * more than `POLL_BATCH_SIZE` holds could push the newest-flagged past the batch limit
   * — a bounded, self-healing reconcile delay WITHIN the flagged group, deferred to #164;
   * fresh-order liveness is unaffected.)
   */
  findSubmittedForPolling(limit: number): Promise<SubmittedOrderForPolling[]> {
    return prisma.order.findMany({
      where: { status: "PAID", fulfillmentStatus: "SUBMITTED" },
      orderBy: [
        // Not-yet-flagged (null) first, then flagged-stuck last — #158 deprioritises a
        // never-resolving hold so it can't starve fresh orders (see the doc comment).
        { fulfillmentStuckAt: { sort: "asc", nulls: "first" } },
        { createdAt: "asc" },
      ],
      take: limit,
      select: {
        id: true,
        tenantId: true,
        fulfillmentExternalId: true,
        // Age anchor + already-surfaced marker for the stuck-open-shipment check
        // (#155), and — since #158 — the batch's primary sort key: a flagged order is
        // re-polled like any other (a hold can still resolve to a shipment), so it
        // stays in this same `{PAID, SUBMITTED}` work list, just sorted to the tail.
        createdAt: true,
        fulfillmentStuckAt: true,
      },
    });
  },

  /**
   * Recent PENDING orders (newest first) that could be the *same* in-flight
   * checkout a shopper is re-submitting — the dedupe read behind
   * `orderService.startCheckout` (#25). Scoped to the tenant (golden rule #1) and
   * the caller's identity (#92), and pre-filtered to the re-priced cart's exact
   * `currency` + `totalCents`, so a stale-priced prior attempt can never be a
   * candidate; `createdAfter` bounds it to the reuse window. Returns the orders
   * *with items* so the service can confirm the line-set matches before reusing the
   * linked PaymentIntent's client secret. Newest first so the freshest attempt wins.
   *
   * Identity binding (#92) is the fix for a guest reuse trusting a client-supplied
   * email: an authenticated shopper (`q.userId !== null`) matches on the
   * session-proven `userId` alone — the typed email is never part of the match; a
   * guest (`q.userId === null`) matches on `email` but is pinned to `userId: null`,
   * so a guest-supplied email can't match — and hand back — a signed-in shopper's
   * in-flight order. Both branches are served by the `[tenantId, userId, createdAt]`
   * index (#102): `userId` is an equality (a value or `null`) either way.
   *
   * Return type is left to inference (like the other `include: { items: true }`
   * reads here): annotating it `OrderWithItems[]` would make `orderRepository`'s
   * type reference `OrderWithItems`, which is itself derived from `orderRepository`
   * — a circular reference. The inferred shape is structurally `OrderWithItems`.
   */
  findReusablePendingCandidates(q: ReusablePendingQuery) {
    return prisma.order.findMany({
      where: {
        tenantId: q.tenantId,
        status: "PENDING",
        currency: q.currency,
        totalCents: q.totalCents,
        createdAt: { gte: q.createdAfter },
        // Identity binding (#92): a signed-in shopper is matched on the
        // session-proven `userId`; a guest on `email`, but pinned to `userId: null`
        // so a guest email can never reuse a signed-in shopper's in-flight order.
        ...(q.userId !== null
          ? { userId: q.userId }
          : { userId: null, email: q.email }),
      },
      orderBy: { createdAt: "desc" },
      take: q.limit,
      include: { items: true },
    });
  },

  /**
   * Confirm payment for an order and allocate its inventory, atomically. In one
   * transaction this (a) flips the tenant's order PENDING → PAID for the given
   * PaymentIntent and (b) decrements each line's variant stock. The
   * `status: "PENDING"` guard on the flip is the webhook's idempotency point:
   * only the single delivery that finds the order PENDING transitions it, so a
   * duplicate/late/racing event flips nothing and — sharing this transaction —
   * decrements nothing. No double-processing, no double-decrement, and the order
   * can never regress out of a later state (FULFILLED/REFUNDED).
   *
   * Stock allocation lives here rather than the product repository because it
   * must share the flip's transaction. Each line is decremented with an atomic
   * guarded write (`stock >= quantity`), so it applies fully or not at all and
   * stock can never go negative. The order's inventory was already held at
   * PENDING (see `createWithItems`), so right after the decrement this releases
   * that hold — `reserved` drops by the same amount `stock` did, keeping
   * `available = stock - reserved` correct. If the units aren't there at capture
   * (an admin cut `stock` below the reserved count in the payment window), that
   * line is left untouched and returned as a `shortfall` — the order still stands
   * PAID (the payment is real), and the caller surfaces the shortfall for manual
   * review. (Automated refund/backorder is a follow-up; this covers oversell at
   * capture without ever corrupting stock.)
   *
   * Returns `{ transitioned: false, orderExisted }` when nothing moved —
   * `orderExisted` separates an already-processed intent from an unknown one so
   * the service needn't re-read — or `{ transitioned: true, order, shortfalls }`
   * for the one delivery that made the transition (the paid order feeds the
   * confirmation email; shortfalls flag any oversell).
   */
  async markPaidByPaymentIntent(
    tenantId: string,
    stripePaymentIntentId: string,
  ): Promise<MarkPaidResult> {
    return prisma.$transaction(
      async (tx) => {
        // Read the candidate order (with its lines) inside the transaction: the
        // lines drive stock allocation, and the row's presence lets the service
        // tell a real order from none. Reading PENDING here is NOT the guard — the
        // conditional flip below is — so a concurrent delivery seeing the same
        // PENDING row changes nothing.
        const order = await tx.order.findFirst({
          where: { tenantId, stripePaymentIntentId },
          // Read the lines sorted for a deterministic returned shape; the
          // decrement and release loops below re-sort by `byVariantId`, which is
          // the authoritative global lock order shared with the reserve path — so
          // two transactions that share variants can never deadlock.
          include: { items: { orderBy: { variantId: "asc" } } },
        });
        if (!order) return { transitioned: false, orderExisted: false };

        // Atomic guarded flip — the idempotency point. Under READ COMMITTED the
        // row locks on UPDATE, so of two racing deliveries exactly one still sees
        // `status: "PENDING"` and gets count 1; the other re-checks the committed
        // row (now PAID), matches nothing, and gets count 0. Exactly-once decrement
        // rests on PENDING → PAID being a one-way door: nothing resets an order to
        // PENDING, so this guard can never re-arm and decrement stock twice.
        const { count } = await tx.order.updateMany({
          where: { id: order.id, tenantId, status: "PENDING" },
          data: { status: "PAID" },
        });
        // The order exists but wasn't PENDING (already processed, or lost the
        // race). Report that it existed so the service needn't re-read to tell
        // this normal duplicate apart from a genuinely missing order.
        if (count === 0) return { transitioned: false, orderExisted: true };

        // Transactional outbox (#30): queue the confirmation email in the SAME
        // transaction as the flip, so a paid order can never exist without its
        // confirmation enqueued — that is what turns delivery from at-most-once
        // (the old synchronous webhook send, dropped on a Resend blip) into
        // at-least-once. This write only records the durable *intent*; the actual
        // send + retry-with-backoff is the cron drain's job (outboxService). Since
        // this runs only on the single PENDING → PAID transition, the message is
        // enqueued exactly once; the unique `idempotencyKey` (derived from the
        // order id) is belt-and-suspenders against ever writing two.
        await tx.outboxMessage.create({
          data: {
            tenantId,
            orderId: order.id,
            type: "ORDER_CONFIRMATION",
            idempotencyKey: `oc_${order.id}`,
          },
        });

        // Fulfillment submission (M4 #139): queue the provider submission in this
        // SAME PENDING → PAID transaction, so a paid order that CAN be fulfilled
        // always has its submission durably enqueued — the outbox drain submits it
        // (behind a second, order-level SUBMITTING guard) exactly as it sends the
        // confirmation above. Enqueued only when the order carries a complete
        // shipping address: a guest/legacy order without one has nowhere to ship,
        // so it never attempts submission. Runs only on the single transition (the
        // duplicate delivery already returned above), and the distinct `fs_`
        // idempotencyKey (vs the confirmation's `oc_`) lets both coexist for one
        // order while the unique constraint still forbids ever writing two.
        if (hasShippingAddressColumns(order)) {
          await tx.outboxMessage.create({
            data: {
              tenantId,
              orderId: order.id,
              type: "FULFILLMENT_SUBMISSION",
              idempotencyKey: `fs_${order.id}`,
            },
          });
        }

        // We own the transition — allocate inventory in the same transaction. A
        // line whose stock can't cover its quantity is collected as a shortfall
        // (oversell) rather than forced negative. Reservation makes this rare —
        // the units were held at PENDING — but an admin cutting `stock` below the
        // reserved count between reserve and capture can still under-fill a line,
        // so the guard stays authoritative.
        const short: Array<Omit<StockShortfall, "available">> = [];
        for (const item of [...order.items].sort(byVariantId)) {
          const { count: decremented } = await tx.productVariant.updateMany({
            // Tenant-scoped through the product relation (a variant carries no
            // tenantId) — defence in depth on top of the order's tenant scope.
            // `stock >= quantity` is the oversell guard: never decrement below 0.
            where: {
              id: item.variantId,
              product: { tenantId },
              stock: { gte: item.quantity },
            },
            data: { stock: { decrement: item.quantity } },
          });
          if (decremented === 0) {
            short.push({
              variantId: item.variantId,
              titleSnapshot: item.titleSnapshot,
              ordered: item.quantity,
            });
          }
        }

        // Persist the oversell as a durable flag on the order, in this SAME
        // transaction as the flip — so the admin order view and the confirmation
        // email (#40) can surface it long after the webhook's log line scrolls
        // past. Written only on the (rare) shortfall path; the flag is one-way
        // (nothing clears it) and the order still stands PAID. The returned `order`
        // is the pre-flip snapshot (oversold still false there), but callers read
        // the oversell from `shortfalls`, not this field — the field is for later
        // reads of the persisted row.
        if (short.length > 0) {
          // Tenant-scoped `updateMany` (not `update` by bare id) — defence in
          // depth on top of the tenant-scoped read above, matching the flip's
          // own `{ id, tenantId }` guard (golden rule #1).
          await tx.order.updateMany({
            where: { id: order.id, tenantId },
            data: { oversold: true },
          });
        }

        // Reconcile reservations: the order is now PAID (terminal), so free every
        // line's hold. `stock` already dropped for the lines that decremented, so
        // releasing the matching `reserved` leaves `available = stock - reserved`
        // exactly right; a shortfall line's hold is released too (its `stock`
        // stayed put, so those units return to sellable for a re-stock/refund).
        // Separate and best-effort — floored at 0, never guarded — so it can't
        // disturb the tested decrement/shortfall logic above.
        await releaseReserved(tx, tenantId, order.items);

        // Enrich any shortfalls with the current on-hand count so the oversell
        // alert is actionable. Only the (rare) oversell path pays for this read.
        // Best-effort: it reads the latest committed stock (a concurrent order may
        // have moved it since the failed guard) and only ever feeds a log line —
        // never control flow — so an approximate figure is fine.
        let shortfalls: StockShortfall[] = [];
        if (short.length > 0) {
          const variants = await tx.productVariant.findMany({
            where: {
              id: { in: short.map((s) => s.variantId) },
              product: { tenantId },
            },
            select: { id: true, stock: true },
          });
          const stockById = new Map(variants.map((v) => [v.id, v.stock]));
          shortfalls = short.map((s) => ({
            ...s,
            available: stockById.get(s.variantId) ?? 0,
          }));
        }

        return { transitioned: true, order, shortfalls };
      },
      // Up to MAX_CART_LINES guarded decrements run sequentially in this
      // interactive transaction; lift the default 5s cap so a large order on a
      // high-latency managed Postgres can't time out part-way through allocation.
      { timeout: 15_000 },
    );
  },

  /**
   * A tenant's orders, newest first — the admin orders list. Paginated (`page` is
   * 1-based) and optionally filtered to a single `status`; always tenant-scoped
   * (golden rule #1). Ordered `createdAt DESC` — served by the `[tenantId,
   * createdAt]` index — with `id` as a stable tiebreak so equal timestamps
   * (seeds, bulk writes) never shuffle between page reads. Returns bare orders
   * (no line items): a list row shows number/date/status/total/email, while the
   * detail page loads items via `findByIdForTenant`. `total` is the count for the
   * same filter, for the caller's page math; the two reads are batched into one
   * transaction (a single round-trip) — under READ COMMITTED a write committing
   * between them could skew `total` against the page by a row, which an admin list
   * tolerates. `page`/`pageSize` are floored defensively here (never a negative
   * `skip`, and `take` never flips into Prisma's reverse pagination); the calling
   * boundary must still zod-validate them as positive ints.
   */
  async listByTenant(
    tenantId: string,
    { status, page, pageSize }: ListOrdersParams,
  ): Promise<OrdersPage> {
    const where: Prisma.OrderWhereInput = {
      tenantId,
      ...(status ? { status } : {}),
    };
    const [orders, total] = await prisma.$transaction([
      prisma.order.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: Math.max(0, (page - 1) * pageSize),
        take: Math.max(1, pageSize),
      }),
      prisma.order.count({ where }),
    ]);
    return { orders, total };
  },

  /**
   * A single shopper's orders within a tenant, newest first — the storefront
   * account order history (#104). Scoped by BOTH `tenantId` AND the
   * session-proven `userId` (never `tenantId` alone), so one shopper can never
   * see another's orders even within the same store. Offset-paginated (`page` is
   * 1-based) exactly like the admin `listByTenant`, ordered `createdAt DESC` with
   * `id` as a stable tiebreak — served by the `[tenantId, userId, createdAt]`
   * index (#102). Returns bare orders (no items): a list row shows
   * number/date/status/total, while the detail page loads items via
   * `findByIdForTenantAndUser`. `total` is the count for the same scope (for the
   * caller's page math); the two reads are batched into one transaction (a single
   * round-trip). `page`/`pageSize` are floored defensively here (never a negative
   * `skip`, and `take` never flips into Prisma's reverse pagination); the calling
   * boundary must still zod-validate them as positive ints.
   */
  async listByTenantAndUser(
    tenantId: string,
    userId: string,
    { page, pageSize }: ListUserOrdersParams,
  ): Promise<OrdersPage> {
    const where: Prisma.OrderWhereInput = { tenantId, userId };
    const [orders, total] = await prisma.$transaction([
      prisma.order.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: Math.max(0, (page - 1) * pageSize),
        take: Math.max(1, pageSize),
      }),
      prisma.order.count({ where }),
    ]);
    return { orders, total };
  },

  /**
   * Cancel a PENDING order and release its reservations, atomically — the CANCEL
   * leg of the order state machine. The `status: "PENDING"` guard on the
   * `updateMany` is the transition's one-way door: only a still-PENDING order
   * cancels, so a racing cancel / PAID flip / abandoned-PENDING sweep (#25) can
   * never double-transition, and exactly one caller gets count 1. A PENDING order
   * never decremented stock (it only holds a reservation), so on the winning
   * transition this releases each line's hold — `GREATEST(reserved - qty, 0)`, the
   * shared lock-ordered primitive — returning those units to sellable. The flip
   * and the release share one transaction, so an order is never left CANCELLED
   * with its hold still standing (or a hold released without the cancel).
   *
   * Returns `{ transitioned: true }` for the one caller that made the move, or
   * `{ transitioned: false, currentStatus }` when nothing moved: `null` for no
   * such order in the tenant, a non-null status for one that existed but wasn't
   * PENDING (already paid/cancelled/fulfilled) — the committed status, re-read so
   * the service's message stays truthful even after a lost race. Role-gating
   * (STAFF+) is the caller's job at the action boundary, per the RBAC pattern.
   */
  async cancelPendingAndRelease(
    tenantId: string,
    orderId: string,
  ): Promise<OrderTransitionResult> {
    return prisma.$transaction(
      async (tx) => {
        // Read the order + its lines (ordered by variantId — the global lock
        // order shared with reserve/allocate/release) so the release below can
        // free each hold. This read is NOT the guard; the conditional flip is.
        const order = await tx.order.findFirst({
          where: { tenantId, id: orderId },
          include: { items: { orderBy: { variantId: "asc" } } },
        });
        if (!order) return { transitioned: false, currentStatus: null };

        const { count } = await tx.order.updateMany({
          where: { id: order.id, tenantId, status: "PENDING" },
          data: { status: "CANCELLED" },
        });
        if (count === 0) {
          // Existed but wasn't PENDING (already transitioned, or lost a race
          // since the read above). Re-read the committed status so the caller
          // reports reality, not our pre-guard snapshot.
          const fresh = await tx.order.findFirst({
            where: { tenantId, id: orderId },
            select: { status: true },
          });
          return { transitioned: false, currentStatus: fresh?.status ?? null };
        }

        // We own the PENDING → CANCELLED transition — release every line's hold
        // in the same transaction. Best-effort by construction (floored at 0,
        // never guarded), and reached once per order thanks to the one-way guard,
        // so a hold is released exactly once.
        await releaseReserved(tx, tenantId, order.items);
        return { transitioned: true };
      },
      // The flip plus one release UPDATE per line run in one interactive
      // transaction; lift the default 5s cap for a large order on high-latency
      // managed Postgres (mirrors createWithItems / markPaidByPaymentIntent).
      { timeout: 15_000 },
    );
  },

  /**
   * Mark a PAID order FULFILLED — the FULFIL leg of the state machine, a manual
   * status attestation only. There is no shipping address in the schema and no
   * provider call here: real fulfilment (+ address collection) is M4; this M2
   * method only flips status. The `status: "PAID"` guard is the one-way door, so
   * only a paid order fulfils and a double-submit / racing call transitions once
   * (exactly one caller gets count 1). No inventory work — a PAID order's stock
   * was already decremented and its reservation released at capture.
   *
   * Returns `{ transitioned: true }` for the caller that transitioned, else
   * `{ transitioned: false, currentStatus }`: `null` for no such order, a
   * non-null status for one that wasn't PAID (still pending, already fulfilled /
   * cancelled / refunded). A single guarded `updateMany` is itself atomic, so no
   * surrounding transaction is needed. Role-gating (STAFF+) is the caller's job.
   */
  async markFulfilled(
    tenantId: string,
    orderId: string,
  ): Promise<OrderTransitionResult> {
    const { count } = await prisma.order.updateMany({
      where: { id: orderId, tenantId, status: "PAID" },
      data: { status: "FULFILLED" },
    });
    if (count === 1) return { transitioned: true };

    // Nothing moved: tell an unknown order apart from a wrong-state one so the
    // service can raise the right error. This read runs only on the no-op path.
    const existing = await prisma.order.findFirst({
      where: { tenantId, id: orderId },
      select: { status: true },
    });
    return { transitioned: false, currentStatus: existing?.status ?? null };
  },

  /**
   * Layer-2 idempotency claim for provider submission: atomically move the order's
   * `fulfillmentStatus` NOT_SUBMITTED → SUBMITTING, tenant-scoped. Returns `true`
   * for the single caller that made the move — it, and only it, may call
   * `provider.createOrder` — and `false` for everyone else: a concurrent claimer,
   * or an order already SUBMITTING / SUBMITTED / SHIPPED / FAILED. The guarded
   * `updateMany` is atomic (the `markFulfilled` one-shot idiom, row-locked under
   * READ COMMITTED), so of two racing submissions exactly one wins.
   *
   * This is the SECOND idempotency layer, on top of the outbox message's own
   * claim: a duplicate POD order is real money + a physical shipment, and Printful
   * has no idempotency key, so a submission can never be safely re-attempted once
   * begun. A lost worker (its `createOrder` succeeded but the SUBMITTED write never
   * landed) leaves the order stuck in SUBMITTING; this claim then returns `false`
   * forever, so it is never re-submitted — surfaced for manual reconciliation
   * instead of silently retrying (M4 research, "Idempotent submission").
   *
   * Also guarded on `status: "PAID"` — the only submittable order state. The
   * fulfillment message is enqueued at PENDING → PAID but drained later (the daily
   * outbox cron, or the webhook's immediate dispatch), and in that gap the order
   * may have moved on: a `refund.succeeded` (`markRefundedByPaymentIntent` flips
   * only `status`, not `fulfillmentStatus`) or a manual FULFILLED attestation
   * (`markFulfilled`) both leave `fulfillmentStatus` at NOT_SUBMITTED. Without this
   * guard a refunded order — money already returned — or a hand-fulfilled one would
   * still be shipped to the provider. Both write `status` under the same order row
   * lock, so of the refund/fulfil flip and this claim exactly one wins: a claim
   * that finds the order no longer PAID matches nothing and returns `false`.
   */
  async claimForSubmission(
    tenantId: string,
    orderId: string,
  ): Promise<boolean> {
    const { count } = await prisma.order.updateMany({
      where: {
        id: orderId,
        tenantId,
        status: "PAID",
        fulfillmentStatus: "NOT_SUBMITTED",
      },
      data: { fulfillmentStatus: "SUBMITTING" },
    });
    return count === 1;
  },

  /**
   * Persist a successful submission: the claim-winner (still SUBMITTING) moves
   * SUBMITTING → SUBMITTED and records the provider's own order id
   * (`FulfillmentResult.externalId`) + which provider handled it, so the poll cron
   * can reconcile tracking against them. Guarded on SUBMITTING (like `markSent`'s
   * SENDING guard) so nothing can clobber a FAILED/SHIPPED order. Returns whether
   * the write landed; `false` would mean the order left SUBMITTING underneath us —
   * a should-never-happen (the caller that won the claim holds it exclusively for
   * the one submission), so the caller does not branch on it.
   */
  async markSubmitted(
    tenantId: string,
    orderId: string,
    externalId: string,
    provider: string,
  ): Promise<boolean> {
    const { count } = await prisma.order.updateMany({
      where: { id: orderId, tenantId, fulfillmentStatus: "SUBMITTING" },
      data: {
        fulfillmentStatus: "SUBMITTED",
        fulfillmentExternalId: externalId,
        fulfillmentProvider: provider,
      },
    });
    return count === 1;
  },

  /**
   * Move the order to the terminal FAILED fulfillment state — a provider
   * soft-rejection, or a permanent unmapped / unconfigured / missing-address
   * failure. Guarded to the two pre-terminal states (NOT_SUBMITTED before the
   * claim, SUBMITTING after it) so a FAILED write can never regress an
   * already-SUBMITTED/SHIPPED order. Deliberately persists NO `externalId`: a soft
   * rejection's provider id is a synthesized placeholder (Printful) that must never
   * reach `getTracking`, and FAILED orders are not polled. Best-effort and
   * idempotent — a re-drain after a lost worker re-runs it as a no-op.
   */
  async markFulfillmentFailed(
    tenantId: string,
    orderId: string,
  ): Promise<void> {
    await prisma.order.updateMany({
      where: {
        id: orderId,
        tenantId,
        fulfillmentStatus: { in: ["NOT_SUBMITTED", "SUBMITTING"] },
      },
      data: { fulfillmentStatus: "FAILED" },
    });
  },

  /**
   * Reconcile a shipped order — the SUBMITTED → SHIPPED leg the poll-fulfillment
   * cron drives (M4 #140), and the milestone's second one-way door after PAID. In
   * ONE transaction it (a) flips the order via a guarded `updateMany`, persisting
   * the carrier/number/url the provider reported plus its raw status string
   * (`fulfillmentProviderStatus`, admin display only), and (b) — only if that flip
   * moved a row — enqueues the `SHIPPING_CONFIRMATION` email in the SAME
   * transaction, so a shipped order can never exist without its notification queued
   * (the `markPaidByPaymentIntent` outbox pattern). The distinct `sc_` key coexists
   * with the order's `oc_`/`fs_` messages while the unique constraint still forbids
   * ever writing two.
   *
   * The `updateMany` guard is the idempotency point and does double duty. Guarding
   * on `fulfillmentStatus: "SUBMITTED"` makes a duplicate or racing poll a no-op —
   * the second finds the order already SHIPPED, matches nothing, and enqueues no
   * second email (row locking under READ COMMITTED serializes the two). Guarding
   * ALSO on `status: "PAID"` is the same defence `claimForSubmission` needs: a
   * `refund.succeeded` (`markRefundedByPaymentIntent`) or a manual FULFILLED
   * (`markFulfilled`) flips `status` only, leaving `fulfillmentStatus` at SUBMITTED
   * — without this guard the blind `data.status = "FULFILLED"` would regress a
   * REFUNDED order back to FULFILLED. Both write `status` under the one order-row
   * lock, so of the refund/fulfil flip and this reconcile exactly one wins.
   *
   * Returns whether this call made the transition: `true` for the single poll that
   * reconciled it (order flipped, email enqueued), `false` when nothing moved (a
   * duplicate poll, or the order left PAID+SUBMITTED underneath us) — a safe no-op
   * either way. Never persists a placeholder id: only real SUBMITTED orders (which
   * carry a real `fulfillmentExternalId`) are ever polled here.
   */
  async markShipped(
    tenantId: string,
    orderId: string,
    shipment: ShipmentReconciliation,
  ): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.order.updateMany({
        where: {
          id: orderId,
          tenantId,
          status: "PAID",
          fulfillmentStatus: "SUBMITTED",
        },
        data: {
          status: "FULFILLED",
          fulfillmentStatus: "SHIPPED",
          fulfillmentProviderStatus: shipment.providerStatus,
          trackingCarrier: shipment.carrier,
          trackingNumber: shipment.trackingNumber,
          trackingUrl: shipment.trackingUrl,
        },
      });
      // Nothing moved: a duplicate/racing poll (already SHIPPED), or the order left
      // PAID+SUBMITTED (refunded / manually fulfilled) between the find and here.
      // Enqueue nothing — the email is queued only alongside the real transition.
      if (count === 0) return false;

      // Queue the shipping-confirmation email in this SAME transaction, so a shipped
      // order always has exactly one notification enqueued. Runs only on the single
      // transition above; the unique `sc_` key is belt-and-suspenders against a
      // second write. The send path is M4-08 (#141) — this only records the intent.
      await tx.outboxMessage.create({
        data: {
          tenantId,
          orderId,
          type: "SHIPPING_CONFIRMATION",
          idempotencyKey: `sc_${orderId}`,
        },
      });
      return true;
    });
  },

  /**
   * Move a SUBMITTED order to the terminal FAILED fulfillment state because the
   * provider reported it cancelled/failed AFTER submission — the poll cron's
   * terminal-exit analogue of `markShipped` (M4 #151), and its other one-way door
   * out of SUBMITTED. Without it such an order (the provider will never ship it)
   * would sit SUBMITTED + PAID forever and be re-polled every run, starving newer
   * orders behind it (oldest-first batching) and burning provider rate limit on
   * calls that can never resolve.
   *
   * Guarded on `{status: PAID, fulfillmentStatus: SUBMITTED}` — the exact predicate
   * `findSubmittedForPolling` selects on — so the guarded `updateMany` re-checks the
   * work-list filter under the row lock, mirroring `markShipped` so the poll's two
   * terminal transitions (ship / fail) share one precondition. That makes a
   * duplicate/racing poll a no-op (the order is already FAILED, matches nothing), and
   * leaves an order that concurrently left PAID — a `refund.succeeded`
   * (`markRefundedByPaymentIntent`) or manual FULFILLED (`markFulfilled`), both of
   * which flip only `status` — untouched (it drops from the poll via the status
   * filter anyway). A single guarded `updateMany` is itself atomic, so no surrounding
   * transaction is needed (unlike `markShipped`, which must also enqueue an email).
   *
   * Deliberately flips ONLY `fulfillmentStatus` → FAILED (plus the raw provider
   * status for admin display); `Order.status` stays PAID, so an operator can decide
   * to refund or re-order — the order surfaces as the anomalous pairing "PAID order,
   * FAILED fulfillment". The real `fulfillmentExternalId` is left intact (a FAILED
   * order is never polled, so it can't reach `getTracking` again) — unlike the
   * create-time soft-reject `markFulfillmentFailed`, whose only id was a synthesized
   * placeholder it deliberately dropped. No customer email is enqueued: a provider
   * cancellation is an operator decision (refund/re-order), not a shopper
   * notification. Best-effort + idempotent: a re-run is a guarded no-op.
   *
   * Returns whether this call made the transition — `true` for the single poll that
   * failed it, `false` when nothing moved (already FAILED, or the order left
   * PAID+SUBMITTED underneath us) — mirroring `markShipped` so `pollOne` treats a
   * `false` as the same benign no-op it does there.
   */
  async markFulfillmentFailedAfterSubmission(
    tenantId: string,
    orderId: string,
    providerStatus: string,
  ): Promise<boolean> {
    const { count } = await prisma.order.updateMany({
      where: {
        id: orderId,
        tenantId,
        status: "PAID",
        fulfillmentStatus: "SUBMITTED",
      },
      data: {
        fulfillmentStatus: "FAILED",
        fulfillmentProviderStatus: providerStatus,
      },
    });
    return count === 1;
  },

  /**
   * Stamp a SUBMITTED order as a STUCK open shipment (M4 #155) so the poll cron can
   * surface it to the operator exactly once, and snapshot the raw provider status
   * (`onhold`/`inreview`) into `fulfillmentProviderStatus` so the admin order view
   * shows WHICH hold to chase without log-diving (M4 #161). Still the deliberate
   * INVERSE of `markFulfillmentFailedAfterSubmission`: `fulfillmentStatus` stays
   * SUBMITTED and `status` stays PAID — an order the provider is holding can still
   * ship, so it must keep being polled; we only mark that we've alerted on it. #155
   * is about AGE, not a terminal provider status like #151's cancelled/failed.
   *
   * The provider status is a one-shot SNAPSHOT taken on the single flagging run, not
   * refreshed each poll: the write rides the same `fulfillmentStuckAt: null`-guarded
   * `updateMany` as the marker, so it fires exactly once and never again — preserving
   * both the "surface once" idempotency and the invariant that an in-flight (not-yet-
   * shipped) poll writes nothing on later runs. That mirrors the two terminal writers
   * (`markShipped`, `markFulfillmentFailedAfterSubmission`), which likewise persist the
   * status as a snapshot at their transition, and it stays admin-display only, never a
   * control-flow input. Trade-off: a later `onhold`→`inreview` shift isn't reflected —
   * acceptable, since the operator, once alerted, gets live status from the provider.
   *
   * Guarded on `{status: PAID, fulfillmentStatus: SUBMITTED, fulfillmentStuckAt: null}`.
   * The PAID+SUBMITTED pair is the exact `findSubmittedForPolling` work-list predicate
   * its two terminal siblings (`markShipped`, `markFulfillmentFailedAfterSubmission`)
   * guard on, so a concurrently refunded / manually-fulfilled order (which flips only
   * `status`) is left untouched here too. The `fulfillmentStuckAt: null` clause is the
   * idempotency point: the single guarded `updateMany` is atomic (no surrounding
   * transaction, like the #151 method), so of two racing polls exactly one stamps it,
   * and every later cron tick matches nothing — the alert fires once, never again.
   *
   * Returns whether THIS call stamped it — `true` for the one poll that surfaced the
   * order, `false` otherwise (already surfaced, or it left PAID/SUBMITTED underneath
   * us) — so `pollOne` alerts only on the `true`, mirroring `markShipped`'s contract.
   */
  async markFulfillmentStuck(
    tenantId: string,
    orderId: string,
    providerStatus: string,
  ): Promise<boolean> {
    const { count } = await prisma.order.updateMany({
      where: {
        id: orderId,
        tenantId,
        status: "PAID",
        fulfillmentStatus: "SUBMITTED",
        fulfillmentStuckAt: null,
      },
      data: {
        fulfillmentStuckAt: new Date(),
        fulfillmentProviderStatus: providerStatus,
      },
    });
    return count === 1;
  },

  /**
   * Mark a PAID or FULFILLED order REFUNDED by its Stripe PaymentIntent — the
   * REFUND leg of the state machine, driven solely by the verified `refund.*`
   * webhook (the admin initiation only calls Stripe; it never writes). The
   * `status: { in: ["PAID", "FULFILLED"] }` guard is the one-way door: only a
   * captured order refunds, so a duplicate / late / racing `refund.succeeded`
   * delivery flips nothing (exactly one delivery gets count 1) and the order can
   * never regress into REFUNDED from PENDING/CANCELLED. No inventory work:
   * restock on refund is deliberately manual (goodwill vs return is ambiguous),
   * so a REFUNDED order's stock is left exactly as the sale left it. A single
   * guarded `updateMany` is itself atomic — no surrounding transaction, mirroring
   * `markFulfilled`.
   *
   * Scoped by `tenantId` (golden rule #1) even though `stripePaymentIntentId` is
   * globally unique — defence in depth that also keeps a foreign intent invisible.
   * Returns `{ transitioned: true }` for the delivery that made the move, else
   * `{ transitioned: false, currentStatus }`: `null` for no order matching the
   * intent in this tenant, a non-null status for one that wasn't PAID/FULFILLED
   * (already REFUNDED, or — anomalously — still PENDING/CANCELLED). The status is
   * re-read on the no-op path so the webhook's log stays truthful after a lost
   * race.
   */
  async markRefundedByPaymentIntent(
    tenantId: string,
    stripePaymentIntentId: string,
  ): Promise<OrderTransitionResult> {
    const { count } = await prisma.order.updateMany({
      where: {
        tenantId,
        stripePaymentIntentId,
        status: { in: ["PAID", "FULFILLED"] },
      },
      data: { status: "REFUNDED" },
    });
    if (count === 1) return { transitioned: true };

    // Nothing moved: tell an unknown intent apart from a wrong-state order so the
    // webhook logs the right level. This read runs only on the no-op path.
    const existing = await prisma.order.findFirst({
      where: { tenantId, stripePaymentIntentId },
      select: { status: true },
    });
    return { transitioned: false, currentStatus: existing?.status ?? null };
  },
};

/** An order joined with its line items — the shape `findByPaymentIntentForTenant`
 *  returns (never null). The one order type the webhook and email layer share. */
export type OrderWithItems = NonNullable<
  Awaited<ReturnType<typeof orderRepository.findByPaymentIntentForTenant>>
>;

/** An order joined with its items and, per item, the variant's fulfillment
 *  mapping (`sku` + `providerVariantId`) — the shape `findForFulfillment` returns
 *  (never null). The one order type the fulfillment service reads (M4 #137). */
export type OrderForFulfillment = NonNullable<
  Awaited<ReturnType<typeof orderRepository.findForFulfillment>>
>;
