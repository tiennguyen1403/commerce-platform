import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Route test for the poll-fulfillment cron entry point. The Bearer gate is
 * unit-tested in `verify-cron-request.test.ts` and the poll logic in
 * `fulfillment.service.test.ts`; here we mock both to drive the route's two
 * branches and confirm its 401-vs-200 contract, that it runs no work when
 * unauthorized, and that it echoes the service's per-run counts in the body with
 * the never-cache header. The logger is stubbed so the test emits no log lines and
 * never loads pino.
 */

vi.mock("@/server/cron/verify-cron-request", () => ({
  verifyCronRequest: vi.fn(),
}));
vi.mock("@/server/services/fulfillment.service", () => ({
  fulfillmentService: { pollOpenShipments: vi.fn() },
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
import { fulfillmentService } from "@/server/services/fulfillment.service";
import { GET } from "@/app/api/cron/poll-fulfillment/route";

const verify = vi.mocked(verifyCronRequest);
const poll = vi.mocked(fulfillmentService.pollOpenShipments);

function request(): Request {
  return new Request("https://example.test/api/cron/poll-fulfillment");
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/cron/poll-fulfillment", () => {
  it("401s an unauthorized request without polling", async () => {
    verify.mockReturnValue(false);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: "Unauthorized" });
    expect(poll).not.toHaveBeenCalled();
  });

  it("200s an authorized request, echoing the poll's per-run counts", async () => {
    verify.mockReturnValue(true);
    poll.mockResolvedValue({ shipped: 2, pending: 3, errored: 1 });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      ok: true,
      task: "poll-fulfillment",
      shipped: 2,
      pending: 3,
      errored: 1,
    });
    expect(poll).toHaveBeenCalledTimes(1);
  });
});
