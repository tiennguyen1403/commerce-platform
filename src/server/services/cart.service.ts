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
  /**
   * Price and reconcile the cookie's lines against live variant data, in the
   * store's `currency`. Every line is in that one currency — the catalog has no
   * per-variant currency (`Tenant.currency` is the single source), so a cart can
   * never mix currencies and the total is always soundly summable and chargeable.
   */
  async getCartView(
    tenantId: string,
    lines: CartLine[],
    currency: string,
  ): Promise<CartView> {
    if (lines.length === 0) return { ...EMPTY_CART, currency };

    const variants = await productRepository.findVariantsForTenant(
      tenantId,
      lines.map((line) => line.variantId),
    );
    const byId = new Map(variants.map((variant) => [variant.id, variant]));

    const items: CartItem[] = [];
    let removedCount = 0;
    let adjusted = false;

    for (const line of lines) {
      const variant = byId.get(line.variantId);
      if (!variant || !isPurchasable(variant)) {
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
        currency,
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
      currency,
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
