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
   * Flip a tenant's order from PENDING to PAID for the given PaymentIntent, and
   * report whether this call is the one that did it. The `status: "PENDING"`
   * clause lives in the WHERE, so the guard and the write are a single atomic
   * statement — this is the webhook's idempotency point. A duplicate delivery
   * (or two deliveries racing) finds no PENDING row and updates nothing, so an
   * order is never double-processed and can never regress out of a later state
   * (FULFILLED/REFUNDED). Returns true only for the single delivery that moved
   * PENDING → PAID; false for an already-processed intent or an unknown one.
   */
  async markPaidByPaymentIntent(
    tenantId: string,
    stripePaymentIntentId: string,
  ): Promise<boolean> {
    const { count } = await prisma.order.updateMany({
      where: { tenantId, stripePaymentIntentId, status: "PENDING" },
      data: { status: "PAID" },
    });
    return count > 0;
  },
};

/** An order joined with its line items — the shape `findByPaymentIntentForTenant`
 *  returns (never null). The one order type the webhook and email layer share. */
export type OrderWithItems = NonNullable<
  Awaited<ReturnType<typeof orderRepository.findByPaymentIntentForTenant>>
>;
