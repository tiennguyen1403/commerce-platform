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
vi.mock("@/server/services/outbox.service", () => ({
  outboxService: { dispatchForOrder: vi.fn() },
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
import { outboxService } from "@/server/services/outbox.service";
import { GET } from "@/app/api/cron/poll-fulfillment/route";

const verify = vi.mocked(verifyCronRequest);
const poll = vi.mocked(fulfillmentService.pollOpenShipments);
const dispatch = vi.mocked(outboxService.dispatchForOrder);

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
    poll.mockResolvedValue({
      shipped: 2,
      failed: 4,
      stuck: 5,
      pending: 3,
      errored: 1,
      shippedOrders: [],
    });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      task: "poll-fulfillment",
      shipped: 2,
      failed: 4,
      stuck: 5,
      pending: 3,
      errored: 1,
    });
    // The internal shipped-order refs are consumed by the route, never leaked.
    expect(body).not.toHaveProperty("shippedOrders");
    expect(poll).toHaveBeenCalledTimes(1);
    // Nothing shipped this run → no immediate dispatch.
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("fires an immediate best-effort dispatch for each order reconciled to SHIPPED", async () => {
    verify.mockReturnValue(true);
    poll.mockResolvedValue({
      shipped: 2,
      failed: 0,
      stuck: 0,
      pending: 0,
      errored: 0,
      shippedOrders: [
        { tenantId: "t1", orderId: "o1" },
        { tenantId: "t2", orderId: "o2" },
      ],
    });

    const response = await GET(request());

    expect(response.status).toBe(200);
    // Each reconciled order gets an immediate send (the outbox drain is the durable
    // path); the shipping email would otherwise wait for the next cron tick's drain.
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledWith("t1", "o1");
    expect(dispatch).toHaveBeenCalledWith("t2", "o2");
  });

  it("stops dispatching once the request time budget is exceeded, leaving the rest to the drain", async () => {
    // A large shipping burst must not push the request past maxDuration: the loop
    // stops once its wall-clock budget elapses; the undispatched rest fall to the
    // durable outbox drain (a safe no-op, the message is already queued).
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      verify.mockReturnValue(true);
      poll.mockResolvedValue({
        shipped: 2,
        failed: 0,
        stuck: 0,
        pending: 0,
        errored: 0,
        shippedOrders: [
          { tenantId: "t1", orderId: "o1" },
          { tenantId: "t2", orderId: "o2" },
        ],
      });
      // The first dispatch pushes the clock past the budget, so the second is skipped.
      dispatch.mockImplementation(async () => {
        vi.setSystemTime(Date.now() + 53_000);
      });

      const response = await GET(request());

      expect(response.status).toBe(200);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith("t1", "o1");
    } finally {
      vi.useRealTimers();
    }
  });
});
