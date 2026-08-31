import "server-only";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { cartCookieSchema, normalizeCart, type CartLine } from "@/lib/cart";

/**
 * Cookie persistence for the guest cart. The cart is a single `httpOnly` cookie
 * holding a JSON array of `{ variantId, qty }` — never price. Reads are tolerant
 * (any missing, malformed, or tampered value collapses to an empty cart); writes
 * normalize first and set the security flags.
 *
 * In Next 16, only Server Actions and Route Handlers may write cookies. Server
 * Components may call `readCart` (read-only) but must never call `writeCart` /
 * `clearCart` — those belong behind the cart Server Actions.
 */

const CART_COOKIE = "cart";
// Persist the guest cart for 30 days: long enough to survive a return visit,
// short enough that abandoned carts don't linger indefinitely.
const CART_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/**
 * Read and normalize the cart from the cookie. Returns `[]` for a missing,
 * unparseable, schema-invalid, or tampered cookie. Safe from a Server Component.
 */
export async function readCart(): Promise<CartLine[]> {
  const store = await cookies();
  const raw = store.get(CART_COOKIE)?.value;
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const result = cartCookieSchema.safeParse(parsed);
  if (!result.success) return [];
  return normalizeCart(result.data);
}

/**
 * Persist the cart. An empty cart deletes the cookie rather than storing `"[]"`.
 * Call only from a Server Action or Route Handler.
 */
export async function writeCart(lines: CartLine[]): Promise<void> {
  const store = await cookies();
  const normalized = normalizeCart(lines);

  if (normalized.length === 0) {
    store.delete(CART_COOKIE);
    return;
  }

  store.set(CART_COOKIE, JSON.stringify(normalized), {
    httpOnly: true,
    sameSite: "lax",
    // Only require HTTPS in production so the cookie still works on local HTTP dev.
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: CART_MAX_AGE_SECONDS,
  });
}

/** Clear the cart entirely. Call only from a Server Action or Route Handler. */
export async function clearCart(): Promise<void> {
  const store = await cookies();
  store.delete(CART_COOKIE);
}
