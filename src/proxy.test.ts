import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { proxy, config } from "@/proxy";
import { TENANT_SLUG_HEADER } from "@/config/constants";

// Build a request for `host` at `path`, optionally carrying extra inbound headers
// (e.g. a crafted tenant header, to prove the proxy strips it). `new
// NextRequest(url)` does NOT populate `host` from the URL, so set it explicitly —
// exactly as a real HTTP request would.
function req(
  host: string,
  path = "/",
  extraHeaders: Record<string, string> = {},
) {
  return new NextRequest(`http://${host}${path}`, {
    headers: { host, ...extraHeaders },
  });
}

// The request header the proxy forwards upstream to the RSC tree. `NextResponse
// .next({ request: { headers } })` encodes each forwarded header as a response
// header `x-middleware-request-<key>` (see Next's `handleMiddlewareField`).
function forwardedHeader(response: Response, key: string): string | null {
  return response.headers.get(`x-middleware-request-${key}`);
}

describe("proxy matcher", () => {
  const matches = (url: string) =>
    unstable_doesMiddlewareMatch({ config, url });

  it("covers the storefront, auth, and admin routes", () => {
    // Every app route runs the proxy: the storefront needs the injected tenant
    // header for its catalog; the admin needs the auth gate.
    expect(matches("/")).toBe(true);
    expect(matches("/products")).toBe(true);
    expect(matches("/products/canvas-tote-bag")).toBe(true);
    expect(matches("/cart")).toBe(true);
    expect(matches("/checkout")).toBe(true);
    expect(matches("/sign-in")).toBe(true);
    expect(matches("/admin")).toBe(true);
    expect(matches("/admin/products/123/edit")).toBe(true);
  });

  it("skips API routes and Next internals/static assets", () => {
    // These never call `getStoreTenant`, so they need no tenant header — and the
    // Stripe webhook/auth handlers must not be touched.
    expect(matches("/api/webhooks/stripe")).toBe(false);
    expect(matches("/api/health")).toBe(false);
    expect(matches("/_next/static/chunk.js")).toBe(false);
    expect(matches("/_next/image")).toBe(false);
    expect(matches("/favicon.ico")).toBe(false);
  });
});

describe("proxy — tenant resolution", () => {
  it("injects a trusted x-tenant-slug for a store host", () => {
    const response = proxy(req("acme.localhost:3000", "/products"));
    expect(forwardedHeader(response, TENANT_SLUG_HEADER)).toBe("acme");
  });

  it("resolves the bare-localhost fallback to the demo store", () => {
    const response = proxy(req("localhost:3000", "/products"));
    expect(forwardedHeader(response, TENANT_SLUG_HEADER)).toBe("demo");
  });

  it("sets no tenant for a reserved subdomain (platform, not a store)", () => {
    const response = proxy(req("www.localhost:3000", "/products"));
    expect(forwardedHeader(response, TENANT_SLUG_HEADER)).toBeNull();
  });

  it("strips a crafted inbound x-tenant-slug, overriding it with the host's", () => {
    // Anti-spoof: a client sends `x-tenant-slug: victim`, but the host is acme's.
    const response = proxy(
      req("acme.localhost:3000", "/products", {
        [TENANT_SLUG_HEADER]: "victim",
      }),
    );
    expect(forwardedHeader(response, TENANT_SLUG_HEADER)).toBe("acme");
  });

  it("deletes a crafted inbound x-tenant-slug entirely on a non-store host", () => {
    // On the platform/apex there is no store, so a forged value must vanish — not
    // merely be ignored — so `getStoreTenant` sees nothing and returns a 404.
    const response = proxy(
      req("www.localhost:3000", "/products", {
        [TENANT_SLUG_HEADER]: "victim",
      }),
    );
    expect(forwardedHeader(response, TENANT_SLUG_HEADER)).toBeNull();
    // Nor is it smuggled through under the override-headers manifest.
    const overridden =
      response.headers.get("x-middleware-override-headers") ?? "";
    expect(overridden.split(",")).not.toContain(TENANT_SLUG_HEADER);
  });
});

describe("proxy — store-host root redirect", () => {
  it("redirects a store host's / to its /products catalog, preserving the query", () => {
    const response = proxy(req("acme.localhost:3000", "/?utm=spring"));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") as string);
    expect(location.host).toBe("acme.localhost:3000");
    expect(location.pathname).toBe("/products");
    expect(location.searchParams.get("utm")).toBe("spring");
  });

  it("does not redirect a non-store (reserved) host's /", () => {
    const response = proxy(req("www.localhost:3000", "/"));
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("proxy — admin auth gate", () => {
  it("redirects an unauthenticated request to /sign-in, preserving the target", () => {
    const response = proxy(req("localhost:3000", "/admin/orders?tab=open"));

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const redirectUrl = new URL(location as string);
    expect(redirectUrl.pathname).toBe("/sign-in");
    expect(redirectUrl.searchParams.get("redirect")).toBe(
      "/admin/orders?tab=open",
    );
  });

  it("lets a request carrying a session cookie through", () => {
    // `proxy()` calls `getSessionCookie(request)` with no config, so it looks for
    // Better Auth's default cookie name (prefix `better-auth`, name
    // `session_token`). This must match; if the auth config ever sets a custom
    // `cookiePrefix`, both proxy.ts and this cookie name have to change together.
    const response = proxy(
      req("localhost:3000", "/admin/orders", {
        cookie: "better-auth.session_token=fake-session-token",
      }),
    );

    // NextResponse.next() is a pass-through: no redirect Location, and it carries
    // Next's internal "continue" marker.
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
