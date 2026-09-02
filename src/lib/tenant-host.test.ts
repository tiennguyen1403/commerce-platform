import { describe, it, expect } from "vitest";
import { resolveTenantSlug } from "@/lib/tenant-host";

// A production-like app domain (no loopback fallback) unless a case overrides it.
const prod = (host: string | null) =>
  resolveTenantSlug({
    host,
    appHost: "example.com",
    allowLocalhostFallback: false,
  });

// A dev/test app domain served from localhost, with the loopback fallback on.
const dev = (host: string | null) =>
  resolveTenantSlug({
    host,
    appHost: "localhost",
    allowLocalhostFallback: true,
  });

describe("resolveTenantSlug — store hosts", () => {
  it("maps a single-label subdomain to that store's slug", () => {
    expect(prod("acme.example.com")).toBe("acme");
    expect(prod("demo.example.com")).toBe("demo");
  });

  it("strips the port before parsing", () => {
    expect(prod("acme.example.com:3000")).toBe("acme");
  });

  it("is case-insensitive on the host (RFC 3986)", () => {
    expect(prod("ACME.Example.COM")).toBe("acme");
  });

  it("keeps hyphenated slugs intact", () => {
    expect(prod("my-cool-shop.example.com")).toBe("my-cool-shop");
  });
});

describe("resolveTenantSlug — non-stores resolve to null", () => {
  it("returns null for the apex host itself", () => {
    expect(prod("example.com")).toBeNull();
    expect(prod("example.com:3000")).toBeNull();
  });

  it("returns null for an unrelated domain", () => {
    expect(prod("evil.com")).toBeNull();
    expect(prod("example.com.evil.com")).toBeNull();
  });

  it("returns null for a multi-level host (only one label is a store)", () => {
    expect(prod("a.b.example.com")).toBeNull();
  });

  it("returns null for a missing host", () => {
    expect(prod(null)).toBeNull();
    expect(prod("")).toBeNull();
  });
});

describe("resolveTenantSlug — reserved subdomains are refused", () => {
  it.each([
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
  ])("refuses %s as a store", (reserved) => {
    expect(prod(`${reserved}.example.com`)).toBeNull();
  });

  it("does NOT reserve 'demo' — it's a real seeded tenant", () => {
    expect(prod("demo.example.com")).toBe("demo");
  });
});

describe("resolveTenantSlug — anti-spoof (host is the only input)", () => {
  it("resolves purely from the host; there is no header to override it", () => {
    // The function takes no request/header input, so a crafted `x-tenant-slug`
    // cannot reach it — the proxy strips it and calls this with the host alone.
    expect(prod("shop.example.com")).toBe("shop");
    // The apex stays null no matter what a client might have sent.
    expect(prod("example.com")).toBeNull();
  });
});

describe("resolveTenantSlug — localhost fallback (dev/test only)", () => {
  it("resolves bare loopback to the demo store when enabled", () => {
    expect(dev("localhost")).toBe("demo");
    expect(dev("localhost:3000")).toBe("demo");
    expect(dev("127.0.0.1")).toBe("demo");
    expect(dev("127.0.0.1:3000")).toBe("demo");
  });

  it("still resolves real subdomains under a localhost app host", () => {
    expect(dev("acme.localhost:3000")).toBe("acme");
    expect(dev("demo.localhost:3000")).toBe("demo");
    expect(dev("www.localhost:3000")).toBeNull(); // reserved → apex/platform
  });

  it("does NOT fall back when disabled (production): bare loopback is not a store", () => {
    expect(
      resolveTenantSlug({
        host: "localhost:3000",
        appHost: "example.com",
        allowLocalhostFallback: false,
      }),
    ).toBeNull();
    // Even with a localhost app host, a disabled fallback yields no store.
    expect(
      resolveTenantSlug({
        host: "localhost",
        appHost: "localhost",
        allowLocalhostFallback: false,
      }),
    ).toBeNull();
  });
});
