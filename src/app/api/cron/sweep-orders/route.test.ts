import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Route test for the abandoned-PENDING-order-sweep cron entry point. The Bearer
 * gate is unit-tested in `verify-cron-request.test.ts` and the sweep logic in
 * `order.service.test.ts`; here we mock both to drive the route's two branches and
 * confirm its 401-vs-200 contract, that it runs no work when unauthorized, and
 * that it echoes the service's per-run counts in the body with the never-cache
 * header. The logger is stubbed so the test emits no log lines and never loads pino.
 */

vi.mock("@/server/cron/verify-cron-request", () => ({
  verifyCronRequest: vi.fn(),
}));
vi.mock("@/server/services/order.service", () => ({
  orderService: { sweepAbandonedPending: vi.fn() },
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
import { orderService } from "@/server/services/order.service";
import { GET } from "@/app/api/cron/sweep-orders/route";

const verify = vi.mocked(verifyCronRequest);
const sweep = vi.mocked(orderService.sweepAbandonedPending);

function request(): Request {
  return new Request("https://example.test/api/cron/sweep-orders");
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/cron/sweep-orders", () => {
  it("401s an unauthorized request without sweeping", async () => {
    verify.mockReturnValue(false);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: "Unauthorized" });
    expect(sweep).not.toHaveBeenCalled();
  });

  it("200s an authorized request, echoing the sweep's per-run counts", async () => {
    verify.mockReturnValue(true);
    sweep.mockResolvedValue({ swept: 2, skipped: 1, errored: 0 });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      ok: true,
      task: "sweep-orders",
      swept: 2,
      skipped: 1,
      errored: 0,
    });
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});
