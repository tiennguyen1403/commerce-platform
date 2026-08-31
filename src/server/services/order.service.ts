import { randomInt, randomUUID } from "node:crypto";
import { getStripe } from "@/lib/stripe";
import { cartService } from "@/server/services/cart.service";
import {
  orderRepository,
  type CreateOrderInput,
} from "@/server/repositories/order.repository";
import { EmptyCartError, OrderNumberTakenError } from "@/server/order.errors";
import type { CartLine } from "@/lib/cart";

/**
 * Checkout business logic. Turns a cookie's `{ variantId, qty }[]` into a
 * PaymentIntent + a PENDING order with snapshotted line items. Price is the
 * security boundary: totals and per-line prices come from a fresh variant read
 * via the cart service (never the cookie/client), so a tampered cart can name
 * items but can't move money. Stays free of Prisma (the repository owns that);
 * it does own the Stripe call, since that's a checkout concern, not persistence.
 *
 * "Paid" is deliberately NOT set here — the order lands as PENDING and the
 * Stripe webhook (#14) owns the PENDING → PAID transition.
 */

// Re-export so the Server Action boundary imports checkout errors from one place.
export { EmptyCartError } from "@/server/order.errors";

export type StartCheckoutResult = {
  clientSecret: string;
  orderId: string;
  orderNumber: string;
  totalCents: number;
  currency: string;
};

// Human-friendly, unambiguous order-number suffix: no 0/1/I/O to misread.
const ORDER_NUMBER_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const ORDER_NUMBER_SUFFIX_LEN = 6;
// Bound the retry so a pathological collision streak can't loop forever; with a
// per-day-per-tenant keyspace of 31^6 (~887M) it effectively never recurs.
const MAX_ORDER_NUMBER_ATTEMPTS = 5;

/** `YYYYMMDD-XXXXXX` — a UTC date prefix for at-a-glance sorting plus a random,
 *  collision-resistant suffix. Uniqueness is enforced per tenant by the DB. */
function generateOrderNumber(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  let suffix = "";
  for (let i = 0; i < ORDER_NUMBER_SUFFIX_LEN; i++) {
    suffix += ORDER_NUMBER_ALPHABET[randomInt(ORDER_NUMBER_ALPHABET.length)];
  }
  return `${date}-${suffix}`;
}

/** Persist the order, retrying with a fresh order number on the (rare) unique
 *  collision. Any other failure — or an exhausted retry budget — propagates. */
async function createOrderWithRetry(
  input: Omit<CreateOrderInput, "orderNumber">,
) {
  for (let attempt = 1; attempt <= MAX_ORDER_NUMBER_ATTEMPTS; attempt++) {
    try {
      return await orderRepository.createWithItems({
        ...input,
        orderNumber: generateOrderNumber(),
      });
    } catch (err) {
      if (
        err instanceof OrderNumberTakenError &&
        attempt < MAX_ORDER_NUMBER_ATTEMPTS
      ) {
        continue;
      }
      throw err;
    }
  }
  // Unreachable: the final attempt either returns or throws.
  throw new OrderNumberTakenError();
}

/** Cancel an orphaned PaymentIntent after a failed order write. Best-effort: an
 *  uncancelled, unconfirmed intent simply expires, so failure here is swallowed. */
async function cancelPaymentIntentQuietly(
  paymentIntentId: string,
): Promise<void> {
  try {
    await getStripe().paymentIntents.cancel(paymentIntentId);
  } catch {
    // Intentionally ignored.
  }
}

export const orderService = {
  /**
   * Begin checkout: reconcile the cart against live variants, create a Stripe
   * PaymentIntent for the recomputed total, then write a PENDING order + its
   * snapshotted items in one transaction (with the PaymentIntent linked). The
   * order id is pre-generated so it can ride in the PaymentIntent's metadata
   * while the row is written with the intent id in a single write. Returns the
   * `clientSecret` the browser needs to mount the Payment Element.
   */
  async startCheckout(
    tenantId: string,
    lines: CartLine[],
    email: string,
  ): Promise<StartCheckoutResult> {
    const cart = await cartService.getCartView(tenantId, lines);
    if (cart.items.length === 0) throw new EmptyCartError();

    const orderId = randomUUID();
    const stripe = getStripe();

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: cart.totalCents,
        currency: cart.currency,
        // The webhook (#14) reads these to flip PENDING → PAID and scope the
        // tenant; they also make the charge traceable in the Stripe dashboard.
        metadata: { orderId, tenantId },
        receipt_email: email,
        automatic_payment_methods: { enabled: true },
      },
      // Same key across a network retry of this exact call → at most one intent.
      { idempotencyKey: orderId },
    );

    if (!paymentIntent.client_secret) {
      await cancelPaymentIntentQuietly(paymentIntent.id);
      throw new Error("Stripe did not return a client secret");
    }

    const items = cart.items.map((item) => ({
      variantId: item.variantId,
      // Snapshot the readable name so later catalog edits never rewrite history.
      titleSnapshot: `${item.productTitle} — ${item.variantName}`,
      priceCents: item.unitPriceCents,
      quantity: item.qty,
    }));

    try {
      const order = await createOrderWithRetry({
        id: orderId,
        tenantId,
        email,
        totalCents: cart.totalCents,
        currency: cart.currency,
        stripePaymentIntentId: paymentIntent.id,
        items,
      });
      return {
        clientSecret: paymentIntent.client_secret,
        orderId: order.id,
        orderNumber: order.orderNumber,
        totalCents: order.totalCents,
        currency: order.currency,
      };
    } catch (err) {
      // Order write failed (collisions exhausted, DB down, …). Cancel the now
      // orphaned intent so no chargeable PaymentIntent is left without an order.
      await cancelPaymentIntentQuietly(paymentIntent.id);
      throw err;
    }
  },

  /** The order behind a Stripe PaymentIntent, scoped to the tenant (or null). */
  getOrderByPaymentIntent(tenantId: string, paymentIntentId: string) {
    return orderRepository.findByPaymentIntentForTenant(
      tenantId,
      paymentIntentId,
    );
  },
};
