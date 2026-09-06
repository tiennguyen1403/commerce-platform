import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The storage provider selector. `@/lib/env` is mocked with a mutable object so
 * each case can flip `BLOB_READ_WRITE_TOKEN` / `NODE_ENV` — the selector reads them
 * at call time, so no module reset is needed. Asserts the provider decision without
 * constructing the real, boot-validated env.
 *
 * The `token set → real Vercel Blob provider` branch is live (M5-06): a token now
 * selects the `VercelBlobStorageProvider` in every environment. Its constructor is
 * side-effect-free (the token is read at call time), so building it here touches no
 * network; `@vercel/blob` is imported for real but never invoked.
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

  it("selects the real Vercel Blob provider in dev/test when a token is set", () => {
    mockEnv.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_token";
    expect(getStorageProvider()?.name).toBe("vercel-blob");
  });

  it("selects the real Vercel Blob provider in production when a token is set", () => {
    mockEnv.NODE_ENV = "production";
    mockEnv.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_token";
    expect(getStorageProvider()?.name).toBe("vercel-blob");
  });

  it("memoizes a single mock instance (the getStripe singleton pattern)", () => {
    expect(getStorageProvider()).toBe(getStorageProvider());
  });

  it("memoizes a single Blob instance (the getStripe singleton pattern)", () => {
    mockEnv.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_token";
    expect(getStorageProvider()).toBe(getStorageProvider());
  });
});
