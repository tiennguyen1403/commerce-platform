import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { OrderNumberTakenError } from "@/server/order.errors";

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

export const orderRepository = {
  /**
   * Create an order and its line items in one atomic write. Prisma runs the
   * parent + nested `create` inside a single transaction, so an order never
   * exists without its items. A duplicate `orderNumber` surfaces as
   * `OrderNumberTakenError` for the service to retry.
   */
  async createWithItems(input: CreateOrderInput) {
    try {
      return await prisma.order.create({
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
   * stock can never go negative. If the units aren't there at capture (another
   * shopper took the last of them during the payment window), that line is left
   * untouched and returned as a `shortfall` — the order still stands PAID (the
   * payment is real), and the caller surfaces the shortfall for manual review.
   * (Automated refund/backorder and reserve-at-PENDING with an expiry sweep are
   * follow-ups; this covers oversell at capture without ever corrupting stock.)
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
          // Order the lines by variantId so the guarded decrements below always
          // lock variant rows in a consistent global order: two orders paid at
          // once that share variants then can't deadlock by locking the same rows
          // in opposite orders (Postgres would abort one — self-healing via the
          // webhook retry, but noisy and it delays the PAID/email under load).
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
        // (oversell) rather than forced negative.
        const short: Array<Omit<StockShortfall, "available">> = [];
        for (const item of order.items) {
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
};

/** An order joined with its line items — the shape `findByPaymentIntentForTenant`
 *  returns (never null). The one order type the webhook and email layer share. */
export type OrderWithItems = NonNullable<
  Awaited<ReturnType<typeof orderRepository.findByPaymentIntentForTenant>>
>;
