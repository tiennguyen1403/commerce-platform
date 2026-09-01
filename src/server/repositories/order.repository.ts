import "server-only";
import { Prisma, type Order, type OrderStatus } from "@prisma/client";
import { prisma } from "@/server/db";
import {
  OrderNumberTakenError,
  InsufficientStockError,
} from "@/server/order.errors";

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

/** A full order to persist. The `id`, `orderNumber`, total, and per-item prices
 *  are all computed by the service (from a fresh variant read) — never the
 *  client. `id` is pre-generated so the linked PaymentIntent can carry it in
 *  metadata while the row is written with the PaymentIntent id in one write. */
export type CreateOrderInput = {
  id: string;
  tenantId: string;
  orderNumber: string;
  email: string;
  totalCents: number;
  currency: string;
  stripePaymentIntentId: string;
  items: CreateOrderItemInput[];
};

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
};

/** An order joined with its line items — the shape `findByPaymentIntentForTenant`
 *  returns (never null). The one order type the webhook and email layer share. */
export type OrderWithItems = NonNullable<
  Awaited<ReturnType<typeof orderRepository.findByPaymentIntentForTenant>>
>;
