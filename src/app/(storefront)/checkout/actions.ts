"use server";

import { getStoreTenant } from "@/server/store-context";
import { readCart } from "@/server/cart-cookie";
import {
  orderService,
  EmptyCartError,
  InsufficientStockError,
} from "@/server/services/order.service";
import { reportError } from "@/server/observability/error-reporter";
import { checkoutInputSchema } from "@/lib/validators/checkout";

/**
 * Start-checkout Server Action. Public endpoint, so it re-validates its input and
 * — critically — never trusts a client-supplied cart: it reads the cart from the
 * cookie and re-prices it server-side. The shopper supplies only their email.
 * Returns the PaymentIntent `clientSecret` (plus the authoritative amount) for
 * the browser to mount the Payment Element, or a friendly error message.
 */
export async function startCheckoutAction(input: {
  email: string;
}): Promise<
  | { ok: true; clientSecret: string; totalCents: number; currency: string }
  | { ok: false; error: string }
> {
  const parsed = checkoutInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Enter a valid email address.",
    };
  }

  const { tenantId, currency: storeCurrency } = await getStoreTenant();
  const lines = await readCart();

  try {
    const { clientSecret, totalCents, currency } =
      await orderService.startCheckout(
        tenantId,
        lines,
        parsed.data.email,
        storeCurrency,
      );
    return { ok: true, clientSecret, totalCents, currency };
  } catch (err) {
    if (err instanceof EmptyCartError) {
      return {
        ok: false,
        error: "Your cart is empty. Add an item before checking out.",
      };
    }
    if (err instanceof InsufficientStockError) {
      // Sold out during the shopper's session — an expected race, not a fault:
      // the reserve guard turned the order away and the service already cancelled
      // the orphaned PaymentIntent. Nudge them back to the cart to re-reconcile.
      return {
        ok: false,
        error:
          "Sorry — some items just sold out. Please review your cart and try again.",
      };
    }
    // Unexpected (Stripe/DB) failure — never leak internals to the client. This
    // Server Action swallows the error and returns a friendly message, so Next's
    // onRequestError hook never sees it: report it here at the catch site.
    await reportError(err, { action: "startCheckout", tenantId });
    return {
      ok: false,
      error: "Something went wrong starting checkout. Please try again.",
    };
  }
}
