import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { proxy, config } from "@/proxy";

describe("proxy matcher", () => {
  const matches = (url: string) =>
    unstable_doesMiddlewareMatch({ config, url });

  it("matches the admin area and its subpaths", () => {
    expect(matches("/admin")).toBe(true);
    expect(matches("/admin/products")).toBe(true);
    expect(matches("/admin/products/123/edit")).toBe(true);
  });

  it("ignores storefront and auth routes", () => {
    expect(matches("/")).toBe(false);
    expect(matches("/products")).toBe(false);
    expect(matches("/sign-in")).toBe(false);
    // Must not match a route that merely starts with "admin".
    expect(matches("/administrator")).toBe(false);
  });
});

describe("proxy handler", () => {
  it("redirects an unauthenticated request to /sign-in, preserving the target", () => {
    const request = new NextRequest(
      "http://localhost:3000/admin/orders?tab=open",
    );

    const response = proxy(request);

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
    const request = new NextRequest("http://localhost:3000/admin/orders", {
      headers: { cookie: "better-auth.session_token=fake-session-token" },
    });

    const response = proxy(request);

    // NextResponse.next() is a pass-through: no redirect Location, and it carries
    // Next's internal "continue" marker.
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
