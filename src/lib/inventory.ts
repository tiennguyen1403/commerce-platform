/**
 * Inventory math shared by the storefront reads. Pure and dependency-free (no
 * `server-only` import), so a client component could use it too — though today
 * the callers compute `available` on the server and pass only the number down.
 */

/**
 * Sellable units for a variant: physical `stock` minus the units `reserved` by
 * in-flight (PENDING) orders. Floored at 0 so an admin cutting `stock` below the
 * reserved count reads as sold out rather than a negative count. This — never
 * `stock` alone — is what the storefront shows and clamps a cart line to; the
 * reserve guard at checkout is the authoritative gate.
 */
export function availableUnits(variant: {
  stock: number;
  reserved: number;
}): number {
  return Math.max(0, variant.stock - variant.reserved);
}
