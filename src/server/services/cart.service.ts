import { productRepository } from "@/server/repositories/product.repository";
import { MAX_CART_QTY, type CartItem, type CartLine } from "@/lib/cart";

/**
 * Cart business logic. Turns the cookie's `{ variantId, qty }[]` into a priced,
 * reconciled view by reading live `ProductVariant` rows: price, title, and stock
 * always come from the DB, never the cookie. Lines are dropped when the variant
 * no longer resolves for the tenant, its product isn't ACTIVE, or it's out of
 * stock; quantities are clamped down to available stock. This reconciliation is
 * the security boundary the cart — and, later, checkout — both rely on. Stays
 * free of Prisma (repositories own that).
 */

export type CartView = {
  items: CartItem[];
  totalCents: number;
  currency: string;
  itemCount: number;
  /** Lines dropped because the variant is gone / inactive / out of stock. */
  removedCount: number;
  /** True when any line's qty was reduced to fit available stock. */
  adjusted: boolean;
};

const EMPTY_CART: CartView = {
  items: [],
  totalCents: 0,
  currency: "usd",
  itemCount: 0,
  removedCount: 0,
  adjusted: false,
};

function isPurchasable(variant: {
  stock: number;
  product: { status: string };
}): boolean {
  return variant.product.status === "ACTIVE" && variant.stock > 0;
}

export const cartService = {
  /** Price and reconcile the cookie's lines against live variant data. */
  async getCartView(tenantId: string, lines: CartLine[]): Promise<CartView> {
    if (lines.length === 0) return EMPTY_CART;

    const variants = await productRepository.findVariantsForTenant(
      tenantId,
      lines.map((line) => line.variantId),
    );
    const byId = new Map(variants.map((variant) => [variant.id, variant]));

    const items: CartItem[] = [];
    let removedCount = 0;
    let adjusted = false;
    // The cart settles on the currency of its first purchasable line; any line
    // in a different currency is set aside. M1 is single-currency in practice,
    // but per-variant currency is allowed and a mixed total can't be summed or
    // charged soundly. (A per-tenant currency constraint at the catalog layer is
    // the longer-term fix — tracked as a follow-up.)
    let cartCurrency: string | null = null;

    for (const line of lines) {
      const variant = byId.get(line.variantId);
      if (!variant || !isPurchasable(variant)) {
        removedCount += 1;
        continue;
      }

      cartCurrency ??= variant.currency;
      if (variant.currency !== cartCurrency) {
        removedCount += 1;
        continue;
      }

      const qty = Math.min(line.qty, variant.stock, MAX_CART_QTY);
      if (qty < line.qty) adjusted = true;

      items.push({
        variantId: variant.id,
        productSlug: variant.product.slug,
        productTitle: variant.product.title,
        variantName: variant.name,
        unitPriceCents: variant.priceCents,
        currency: variant.currency,
        qty,
        lineTotalCents: variant.priceCents * qty,
        stock: variant.stock,
      });
    }

    const totalCents = items.reduce(
      (sum, item) => sum + item.lineTotalCents,
      0,
    );
    const itemCount = items.reduce((sum, item) => sum + item.qty, 0);

    return {
      items,
      totalCents,
      currency: cartCurrency ?? EMPTY_CART.currency,
      itemCount,
      removedCount,
      adjusted,
    };
  },

  /**
   * Resolve a single variant for a mutation: confirm it's purchasable for the
   * tenant and return the requested qty clamped to live stock (and the hard
   * max). Returns `{ ok: false }` for an unknown, foreign, inactive, or
   * out-of-stock variant.
   */
  async resolveLine(
    tenantId: string,
    variantId: string,
    requestedQty: number,
  ): Promise<{ ok: true; qty: number } | { ok: false }> {
    const [variant] = await productRepository.findVariantsForTenant(tenantId, [
      variantId,
    ]);
    if (!variant || !isPurchasable(variant)) return { ok: false };
    return {
      ok: true,
      qty: Math.min(requestedQty, variant.stock, MAX_CART_QTY),
    };
  },
};
