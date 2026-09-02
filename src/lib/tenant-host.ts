import { DEMO_TENANT_SLUG, RESERVED_SUBDOMAINS } from "@/config/constants";

/** Inputs for {@link resolveTenantSlug}. */
export interface ResolveTenantSlugOptions {
  /** Raw `Host` header of the request; may carry a port (`shop.example.com:3000`). */
  host: string | null;
  /**
   * Bare domain the platform is served from, without a port (`example.com`, or
   * `localhost` in dev) — derived by the caller from `NEXT_PUBLIC_APP_URL`.
   */
  appHost: string;
  /**
   * Dev/test only: when `true`, a bare `localhost`/`127.0.0.1` host (no
   * subdomain) resolves to the seeded demo store. Keyed by the caller on the app
   * host being loopback, so it's on for local dev and the Playwright suite yet
   * off for any real deployment. Never enable it in production.
   */
  allowLocalhostFallback: boolean;
}

/**
 * Resolve a request `Host` to the storefront tenant slug it addresses, or `null`
 * when the host is the platform apex, a reserved subdomain, or an unrelated
 * domain — none of which are stores.
 *
 * Pure and DB-free: the proxy runs this on every matched request, so it does
 * only string work (the authoritative slug → tenant lookup happens later in
 * `getStoreTenant`). The slug is derived solely from the host, so a client
 * cannot influence it — the anti-spoof guarantee the proxy relies on.
 */
export function resolveTenantSlug({
  host,
  appHost,
  allowLocalhostFallback,
}: ResolveTenantSlugOptions): string | null {
  if (!host) return null;

  // Drop the port, if any, and normalise: Host is case-insensitive (RFC 3986).
  const hostname = host.split(":")[0].toLowerCase();

  // Dev/test convenience: plain loopback is the demo store, so `pnpm dev` and the
  // Playwright suite work on `localhost:3000` without provisioning subdomains.
  if (
    allowLocalhostFallback &&
    (hostname === "localhost" || hostname === "127.0.0.1")
  ) {
    return DEMO_TENANT_SLUG;
  }

  // A store sits exactly one DNS label in front of the app domain:
  // `{slug}.{appHost}`. Anything else — the apex itself, a deeper host, or an
  // unrelated domain — is not a store.
  const suffix = `.${appHost.toLowerCase()}`;
  if (!hostname.endsWith(suffix)) return null;
  const slug = hostname.slice(0, -suffix.length);
  if (!slug || slug.includes(".")) return null;

  // Reserved words are platform infrastructure (www, admin, api, …), not stores.
  if (RESERVED_SUBDOMAINS.has(slug)) return null;

  return slug;
}
