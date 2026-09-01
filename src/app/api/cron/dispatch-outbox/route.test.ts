import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Route test for the outbox-drain cron entry point. The Bearer gate is unit-tested
 * in `verify-cron-request.test.ts` and the drain in `outbox.service.test.ts`; here
 * both are mocked to drive the route's 401-vs-200 contract, confirm it does no
 * work when unauthorized, and confirm it surfaces the drain's counts and its
 * never-cache header. The logger is stubbed so the test emits no log lines.
 */

vi.mock("@/server/cron/verify-cron-request", () => ({
  verifyCronRequest: vi.fn(),
}));
vi.mock("@/server/services/outbox.service", () => ({
  outboxService: { drain: vi.fn() },
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
import { outboxService } from "@/server/services/outbox.service";
import { GET } from "@/app/api/cron/dispatch-outbox/route";

const verify = vi.mocked(verifyCronRequest);
const drain = vi.mocked(outboxService.drain);

function request(): Request {
  return new Request("https://example.test/api/cron/dispatch-outbox");
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/cron/dispatch-outbox", () => {
  it("401s an unauthorized request without draining", async () => {
    verify.mockReturnValue(false);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: "Unauthorized" });
    expect(drain).not.toHaveBeenCalled();
  });

  it("200s an authorized request and returns the drain counts", async () => {
    verify.mockReturnValue(true);
    drain.mockResolvedValue({
      recovered: 1,
      sent: 3,
      failed: 1,
      dead: 0,
      skipped: 2,
    });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      ok: true,
      task: "dispatch-outbox",
      recovered: 1,
      sent: 3,
      failed: 1,
      dead: 0,
      skipped: 2,
    });
    expect(drain).toHaveBeenCalledOnce();
  });
});
