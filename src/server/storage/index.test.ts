import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The storage provider selector. `@/lib/env` is mocked with a mutable object so
 * each case can flip `BLOB_READ_WRITE_TOKEN` / `NODE_ENV` — the selector reads them
 * at call time, so no module reset is needed. Asserts the mock/unconfigured
 * decision without constructing the real, boot-validated env.
 *
 * The `token set → real Vercel Blob provider` branch lands in M5-06 (see
 * `index.ts`); until then a token is inert, so the two token-present cases below
 * pin the *current* behaviour (still mock / still null) — they flip when M5-06
 * prepends the real branch, which is exactly when this test should be updated.
 */
vi.mock("@/lib/env", () => ({
  env: { BLOB_READ_WRITE_TOKEN: undefined, NODE_ENV: "test" },
}));

import { env } from "@/lib/env";
import { getStorageProvider } from "@/server/storage";

const mockEnv = env as unknown as {
  BLOB_READ_WRITE_TOKEN?: string;
  NODE_ENV: string;
};

beforeEach(() => {
  mockEnv.BLOB_READ_WRITE_TOKEN = undefined;
  mockEnv.NODE_ENV = "test";
});

describe("getStorageProvider", () => {
  it("defaults to the local-disk mock in dev/test when no token is set", () => {
    expect(getStorageProvider()?.name).toBe("mock");
  });

  it("is unconfigured (null) in production with no token — the mock never writes to a real deployment", () => {
    mockEnv.NODE_ENV = "production";
    expect(getStorageProvider()).toBeNull();
  });

  it("still returns the mock in dev/test with a token set (the real adapter is M5-06; a token is inert until then)", () => {
    mockEnv.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_token";
    expect(getStorageProvider()?.name).toBe("mock");
  });

  it("is still null in production with a token set (the real adapter is M5-06; a token is inert until then)", () => {
    mockEnv.NODE_ENV = "production";
    mockEnv.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_token";
    expect(getStorageProvider()).toBeNull();
  });

  it("memoizes a single mock instance (the getStripe singleton pattern)", () => {
    expect(getStorageProvider()).toBe(getStorageProvider());
  });
});
