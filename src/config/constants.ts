/**
 * App-wide constants.
 *
 * M1 is single-tenant: the storefront and admin both resolve the seeded
 * "demo" store. Per-tenant subdomains arrive in M3 — until then this constant
 * is the single place that names the active tenant.
 */
export const DEMO_TENANT_SLUG = "demo";

/**
 * A variant is "low stock" when its available units (stock − reserved) fall to
 * this threshold or below. Surfaced on the storefront purchase panel and the
 * admin dashboard's low-stock list — the single source of truth for both.
 */
export const LOW_STOCK_THRESHOLD = 5;
