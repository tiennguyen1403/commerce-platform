"use server";

import { revalidatePath } from "next/cache";
import { getStoreTenant } from "@/server/store-context";
import { readCart, writeCart, clearCart } from "@/server/cart-cookie";
import { cartService } from "@/server/services/cart.service";
import {
  addToCartInputSchema,
  updateQtyInputSchema,
  removeInputSchema,
  setLineQty,
  removeLine,
  cartItemCount,
  MAX_CART_LINES,
  type CartActionResult,
} from "@/lib/cart";

/**
 * Guest-cart mutations. Add/update re-resolve the storefront tenant and
 * re-validate their input with the same zod schemas the UI uses — Server Actions
 * are public endpoints, so client-side checks are UX only. Price is never
 * accepted from the client: add/update reconcile the requested qty against live
 * stock via the cart service, and the cart page recomputes everything again on
 * render. Remove/clear only prune the cookie, so they need no tenant read.
 */

export async function addToCartAction(
  variantId: string,
  qty?: number,
): Promise<CartActionResult> {
  const { tenantId } = await getStoreTenant();

  const parsed = addToCartInputSchema.safeParse({ variantId, qty });
  if (!parsed.success) return { ok: false, error: "That item isn't valid." };

  const lines = await readCart();
  const existing = lines.find(
    (line) => line.variantId === parsed.data.variantId,
  );
  if (!existing && lines.length >= MAX_CART_LINES) {
    return { ok: false, error: "Your cart is full." };
  }

  // "Add" means increment: fold the request into any existing quantity, then let
  // the service clamp the total to live stock.
  const requested = (existing?.qty ?? 0) + parsed.data.qty;
  const resolved = await cartService.resolveLine(
    tenantId,
    parsed.data.variantId,
    requested,
  );
  if (!resolved.ok) {
    return { ok: false, error: "This item is no longer available." };
  }

  const next = setLineQty(lines, parsed.data.variantId, resolved.qty);
  await writeCart(next);
  revalidatePath("/cart");
  return { ok: true, count: cartItemCount(next) };
}

export async function updateQtyAction(
  variantId: string,
  qty: number,
): Promise<CartActionResult> {
  const { tenantId } = await getStoreTenant();

  const parsed = updateQtyInputSchema.safeParse({ variantId, qty });
  if (!parsed.success) return { ok: false, error: "Enter a valid quantity." };

  const lines = await readCart();
  const resolved = await cartService.resolveLine(
    tenantId,
    parsed.data.variantId,
    parsed.data.qty,
  );

  // A variant that's gone unavailable is dropped rather than updated; the cart
  // page's re-render then reflects the reconciled state.
  const next = resolved.ok
    ? setLineQty(lines, parsed.data.variantId, resolved.qty)
    : removeLine(lines, parsed.data.variantId);

  await writeCart(next);
  revalidatePath("/cart");
  return { ok: true, count: cartItemCount(next) };
}

export async function removeFromCartAction(
  variantId: string,
): Promise<CartActionResult> {
  const parsed = removeInputSchema.safeParse({ variantId });
  if (!parsed.success) return { ok: false, error: "That item isn't valid." };

  const next = removeLine(await readCart(), parsed.data.variantId);
  await writeCart(next);
  revalidatePath("/cart");
  return { ok: true, count: cartItemCount(next) };
}

export async function clearCartAction(): Promise<void> {
  await clearCart();
  revalidatePath("/cart");
}
