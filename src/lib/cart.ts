import { z } from "zod";

/**
 * Cart domain — the cookie's shape and the pure rules for changing it. Shared by
 * the client UI (PDP + cart page, for optimistic/UX checks) and the Server
 * Actions (authoritative validation), so this file is pure zod + pure functions
 * and must never import a `server-only` module.
 *
 * Price is NEVER stored here: a cart line is only `{ variantId, qty }`. Every
 * price, title, and total is recomputed from a fresh `ProductVariant` read on the
 * server (see `cart.service.ts`). Tampering with the cookie can at most name an
 * invalid `variantId` or an oversized `qty` — both are rejected or clamped
 * server-side, so the cookie can never move money.
 */

// A single line can't exceed this. Keeps a tampered cookie bounded and satisfies
// the "oversized qty is clamped" rule; live stock is the tighter bound applied
// server-side at render/checkout time.
export const MAX_CART_QTY = 99;
// Cap distinct lines so a hand-edited cookie can't balloon past the ~4KB limit.
export const MAX_CART_LINES = 50;

// Variant ids are cuids; validate as a bounded non-empty string here — the real
// existence + tenant-ownership check is the DB lookup in the cart service.
const variantIdSchema = z.string().trim().min(1).max(64);

export const cartLineSchema = z.object({
  variantId: variantIdSchema,
  qty: z.int().min(1).max(MAX_CART_QTY),
});

export type CartLine = z.infer<typeof cartLineSchema>;

/** The whole cart cookie: a bounded array of lines. */
export const cartCookieSchema = z.array(cartLineSchema).max(MAX_CART_LINES);

// --- Server Action input schemas ------------------------------------------

export const addToCartInputSchema = z.object({
  variantId: variantIdSchema,
  qty: z.int().min(1).max(MAX_CART_QTY).default(1),
});

export const updateQtyInputSchema = z.object({
  variantId: variantIdSchema,
  qty: z.int().min(1).max(MAX_CART_QTY),
});

export const removeInputSchema = z.object({ variantId: variantIdSchema });

/** Discriminated result every cart mutation returns to the client. `count` is
 *  the new total unit count, handy for optimistic header/CTA feedback. */
export type CartActionResult =
  { ok: true; count: number } | { ok: false; error: string };

/**
 * A single priced, reconciled cart line for display — the output of the cart
 * service, consumed by both the server cart page and the client line-item UI.
 * Every field except `qty` comes straight from a live `ProductVariant` read.
 */
export type CartItem = {
  variantId: string;
  productSlug: string;
  productTitle: string;
  variantName: string;
  unitPriceCents: number;
  currency: string;
  qty: number;
  lineTotalCents: number;
  stock: number;
};

// --- Pure reducers ---------------------------------------------------------

/**
 * Collapse a raw line list into a clean cart: merge duplicate variantIds
 * (summing qty), drop non-positive/non-integer qty, clamp each qty to
 * MAX_CART_QTY, and cap the number of distinct lines. First-seen order is
 * preserved. Applied on every cookie read and write so a malformed or tampered
 * cookie can never produce a bad state.
 */
export function normalizeCart(lines: CartLine[]): CartLine[] {
  const byId = new Map<string, number>();
  for (const { variantId, qty } of lines) {
    if (!Number.isInteger(qty) || qty < 1) continue;
    byId.set(variantId, (byId.get(variantId) ?? 0) + qty);
  }
  const out: CartLine[] = [];
  for (const [variantId, qty] of byId) {
    if (out.length >= MAX_CART_LINES) break;
    out.push({ variantId, qty: Math.min(qty, MAX_CART_QTY) });
  }
  return out;
}

/**
 * Set (insert or replace) a line's qty, returning a new array. The qty is
 * clamped to [1, MAX_CART_QTY]; a qty below 1 removes the line instead. The
 * caller is responsible for any stock ceiling (it needs a live read).
 */
export function setLineQty(
  lines: CartLine[],
  variantId: string,
  qty: number,
): CartLine[] {
  if (qty < 1) return removeLine(lines, variantId);
  const clamped = Math.min(qty, MAX_CART_QTY);
  if (lines.some((line) => line.variantId === variantId)) {
    return lines.map((line) =>
      line.variantId === variantId ? { variantId, qty: clamped } : line,
    );
  }
  return [...lines, { variantId, qty: clamped }];
}

/** Remove a line by variantId, returning a new array. */
export function removeLine(lines: CartLine[], variantId: string): CartLine[] {
  return lines.filter((line) => line.variantId !== variantId);
}

/** Total number of units across all lines — the header badge count. */
export function cartItemCount(lines: CartLine[]): number {
  return lines.reduce((sum, line) => sum + line.qty, 0);
}
