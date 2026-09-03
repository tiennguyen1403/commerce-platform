/**
 * App-wide constants.
 */

/**
 * Slug of the seeded "demo" store (`prisma/seed.ts`). It's a real tenant — not a
 * reserved word — so it doubles as the local-dev/test host fallback: when the
 * platform is served from `localhost`, a bare loopback host (no subdomain)
 * resolves here (`src/proxy.ts`), keeping `pnpm dev` and the Playwright suite
 * working without real subdomains. The admin no longer references it — it
 * resolves the store from the `/admin/[storeSlug]` URL — so this is now only the
 * storefront localhost fallback plus the seed's slug.
 */
export const DEMO_TENANT_SLUG = "demo";

/**
 * Request header that carries the host-derived storefront tenant slug from the
 * proxy to `getStoreTenant()`. The proxy (`src/proxy.ts`) is its only trusted
 * writer — it deletes any inbound value first — and `getStoreTenant` its only
 * reader, so a client can never forge the active tenant. Named here so both
 * sides agree on the exact string.
 */
export const TENANT_SLUG_HEADER = "x-tenant-slug";

/**
 * Subdomains that are platform infrastructure, never a store. The proxy refuses
 * them as tenant hosts (routing them to the apex/platform instead of a store),
 * and self-serve onboarding will reject them as slugs (a later M3 issue) — one
 * list, reused, never duplicated. `demo` is deliberately absent: it's a real
 * seeded tenant, and reserving it would break the dev/test fallback above.
 */
export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  "www",
  "admin",
  "app",
  "api",
  "static",
  "assets",
  "cdn",
  "docs",
  "blog",
  "mail",
]);

/**
 * A variant is "low stock" when its available units (stock − reserved) fall to
 * this threshold or below. Surfaced on the storefront purchase panel and the
 * admin dashboard's low-stock list — the single source of truth for both.
 */
export const LOW_STOCK_THRESHOLD = 5;
