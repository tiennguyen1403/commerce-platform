import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { TENANT_SLUG_HEADER } from "@/config/constants";
import { resolveTenantSlug } from "@/lib/tenant-host";

/**
 * Proxy (Next 16 renamed `middleware.ts` → `proxy.ts`, picked up next to the
 * `app` directory — here, `src/`). Runs on the Node runtime (the Next 16
 * default); do NOT add a `runtime` export — Proxy rejects it. Two DB-free
 * concerns, per Next's guidance that Proxy "is not intended for slow data
 * fetching" — it fires on every matched request, prefetches included:
 *
 *  1. Tenant resolution — derive the storefront tenant from the request host
 *     (`{slug}.{app-domain}`) and hand it to the RSC tree as a trusted
 *     `x-tenant-slug`. Any inbound `x-tenant-slug` is deleted first, so a client
 *     can never forge the active tenant; the authoritative slug → tenant lookup
 *     is `getStoreTenant`, this header's only reader.
 *  2. Admin auth gate — an optimistic cookie-only redirect for any `/admin`
 *     path (the bare `/admin` store index and every `/admin/[storeSlug]/…`
 *     below it). The authoritative session + per-store membership check lives in
 *     the store-scoped admin layout
 *     (`src/app/(admin)/admin/[storeSlug]/layout.tsx`), which resolves the tenant
 *     from the URL slug — the prefix gate here needs no slug awareness.
 */

// Bare domain the platform is served from, no port — `example.com` in production,
// `localhost` in dev. Derived once from the existing public app URL (no new
// required env); referenced literally so Next inlines the build-time value.
const APP_HOST = new URL(
  process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
).hostname.toLowerCase();

// The bare-loopback → demo fallback is active only when the platform itself is
// served from localhost — i.e. local dev and the Playwright suite (which boots
// `next start`, so NODE_ENV is "production" yet still on localhost). A real
// deployment points NEXT_PUBLIC_APP_URL at its domain, so APP_HOST is never
// loopback there and the fallback is off. Keying on the host (not NODE_ENV) is
// what keeps the bare-`localhost:3000` E2E suite green against a prod build.
const ALLOW_LOCALHOST_FALLBACK =
  APP_HOST === "localhost" || APP_HOST === "127.0.0.1";

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Strip any client-supplied tenant header up front (anti-spoof, mandatory): the
  // trusted value set below is the only `x-tenant-slug` the app ever sees.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete(TENANT_SLUG_HEADER);

  const tenantSlug = resolveTenantSlug({
    host: request.headers.get("host"),
    appHost: APP_HOST,
    allowLocalhostFallback: ALLOW_LOCALHOST_FALLBACK,
  });

  if (tenantSlug) {
    requestHeaders.set(TENANT_SLUG_HEADER, tenantSlug);
    // A store host has no home page of its own yet — send its root to the catalog,
    // preserving any query (e.g. utm tags on a marketing link). `nextUrl.clone()`
    // keeps the request's host, which is exactly the host we redirect back to.
    if (pathname === "/") {
      const catalogUrl = request.nextUrl.clone();
      catalogUrl.pathname = "/products";
      return NextResponse.redirect(catalogUrl);
    }
  }

  // Admin auth gate: bounce anonymous visitors to sign-in with the original path.
  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    const sessionCookie = getSessionCookie(request);
    if (!sessionCookie) {
      const signInUrl = new URL("/sign-in", request.url);
      signInUrl.searchParams.set("redirect", pathname + request.nextUrl.search);
      return NextResponse.redirect(signInUrl);
    }
  }

  // Continue, forwarding the cleaned/enriched request headers to the RSC tree.
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  // Every route except API handlers and Next internals/static assets. Storefront
  // routes MUST be covered so `x-tenant-slug` reaches their Server Components and
  // Server Actions (a Server Action is a POST to its own route, so an excluded
  // path would strip the tenant from checkout/cart mutations); `/admin` stays
  // covered for the auth gate above.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
