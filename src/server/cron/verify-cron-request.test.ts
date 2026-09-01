import { describe, it, expect, afterEach } from "vitest";
import { verifyCronRequest } from "./verify-cron-request";

/**
 * Unit test for the cron Bearer gate. `verifyCronRequest` reads
 * `process.env.CRON_SECRET` at *call* time (never at import — that's what keeps
 * it lazy), so each case sets/clears the env var directly and restores it after.
 */

const SECRET = "cron-secret-abcdef0123456789";

function request(authorization?: string): Request {
  return new Request("https://example.test/api/cron/dispatch-outbox", {
    headers: authorization ? { authorization } : {},
  });
}

const originalSecret = process.env.CRON_SECRET;
afterEach(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
});

describe("verifyCronRequest", () => {
  it("authorizes a correct Bearer token", () => {
    process.env.CRON_SECRET = SECRET;
    expect(verifyCronRequest(request(`Bearer ${SECRET}`))).toBe(true);
  });

  it("rejects a wrong token of the same length", () => {
    process.env.CRON_SECRET = SECRET;
    const wrong = "x".repeat(SECRET.length);
    expect(verifyCronRequest(request(`Bearer ${wrong}`))).toBe(false);
  });

  it("rejects a token of a different length (no timingSafeEqual throw)", () => {
    process.env.CRON_SECRET = SECRET;
    expect(verifyCronRequest(request(`Bearer ${SECRET}-extra`))).toBe(false);
    expect(verifyCronRequest(request("Bearer short"))).toBe(false);
  });

  it("rejects a missing Authorization header", () => {
    process.env.CRON_SECRET = SECRET;
    expect(verifyCronRequest(request())).toBe(false);
  });

  it("rejects a non-Bearer scheme", () => {
    process.env.CRON_SECRET = SECRET;
    expect(verifyCronRequest(request(`Basic ${SECRET}`))).toBe(false);
  });

  it("rejects a bare token with no scheme, and an empty Bearer token", () => {
    process.env.CRON_SECRET = SECRET;
    expect(verifyCronRequest(request(SECRET))).toBe(false);
    expect(verifyCronRequest(request("Bearer "))).toBe(false);
  });

  it("fails closed when CRON_SECRET is unset — even with a Bearer header", () => {
    delete process.env.CRON_SECRET;
    expect(verifyCronRequest(request("Bearer anything"))).toBe(false);
  });

  it("fails closed when CRON_SECRET is blank/whitespace", () => {
    process.env.CRON_SECRET = "   ";
    // A whitespace-only secret is treated as unset, so nothing matches it — not
    // even a request that echoes the same blank value.
    expect(verifyCronRequest(request("Bearer    "))).toBe(false);
    expect(verifyCronRequest(request("Bearer "))).toBe(false);
  });
});
