import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Route test for the outbox-drain cron entry point. The Bearer gate is unit-tested
 * in `verify-cron-request.test.ts`; here we mock it to drive the two branches and
 * confirm the route's 401-vs-200 contract and its never-cache header. The logger
 * is stubbed so the test emits no log lines and never loads pino.
 */

vi.mock("@/server/cron/verify-cron-request", () => ({
  verifyCronRequest: vi.fn(),
}));
vi.mock("@/server/observability/logger", () => {
  const stub = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => stub,
  };
  return { logger: stub };
});

import { verifyCronRequest } from "@/server/cron/verify-cron-request";
import { GET } from "@/app/api/cron/dispatch-outbox/route";

const verify = vi.mocked(verifyCronRequest);

function request(): Request {
  return new Request("https://example.test/api/cron/dispatch-outbox");
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/cron/dispatch-outbox", () => {
  it("401s an unauthorized request without doing any work", async () => {
    verify.mockReturnValue(false);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: "Unauthorized" });
  });

  it("200s an authorized request with a bounded no-op result", async () => {
    verify.mockReturnValue(true);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      ok: true,
      task: "dispatch-outbox",
      processed: 0,
    });
  });
});
