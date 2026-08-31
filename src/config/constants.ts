/**
 * App-wide constants.
 *
 * M1 is single-tenant: the storefront and admin both resolve the seeded
 * "demo" store. Per-tenant subdomains arrive in M3 — until then this constant
 * is the single place that names the active tenant.
 */
export const DEMO_TENANT_SLUG = "demo";
