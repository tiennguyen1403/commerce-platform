import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The provider selector. `@/lib/env` is mocked with a mutable object so each case
 * can flip `PRINTFUL_API_KEY` / `NODE_ENV` — the selector reads them at call time,
 * so no module reset is needed. Asserts the mock/printful/unconfigured decision
 * without constructing the real, boot-validated env.
 */
vi.mock("@/lib/env", () => ({
  env: { PRINTFUL_API_KEY: undefined, NODE_ENV: "test" },
}));

import { env } from "@/lib/env";
import { getFulfillmentProvider } from "@/server/fulfillment";

const mockEnv = env as unknown as {
  PRINTFUL_API_KEY?: string;
  NODE_ENV: string;
};

beforeEach(() => {
  mockEnv.PRINTFUL_API_KEY = undefined;
  mockEnv.NODE_ENV = "test";
});

describe("getFulfillmentProvider", () => {
  it("defaults to the mock in dev/test when no PRINTFUL_API_KEY is set", () => {
    expect(getFulfillmentProvider()?.name).toBe("mock");
  });

  it("selects Printful when PRINTFUL_API_KEY is set", () => {
    mockEnv.PRINTFUL_API_KEY = "pf_test_123";
    expect(getFulfillmentProvider()?.name).toBe("printful");
  });

  it("is unconfigured (null) in production with no key — the mock never fulfils real orders", () => {
    mockEnv.NODE_ENV = "production";
    expect(getFulfillmentProvider()).toBeNull();
  });

  it("still selects Printful in production once the key is present", () => {
    mockEnv.NODE_ENV = "production";
    mockEnv.PRINTFUL_API_KEY = "pf_live_123";
    expect(getFulfillmentProvider()?.name).toBe("printful");
  });
});
