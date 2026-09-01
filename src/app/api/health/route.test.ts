import { describe, it, expect, beforeEach, vi } from "vitest";
import { healthService } from "@/server/services/health.service";
import { GET } from "@/app/api/health/route";

/**
 * Route test for the readiness probe, with the service mocked. This verifies
 * only the route's job — delegate to `checkReadiness()` and map the result to a
 * status code + body (200/ok when the DB is up, 503/degraded when it's down).
 * No Prisma is touched here, which is the golden-rule-#2 fix this route exists
 * for; the DB ping now lives behind the service → repository.
 */

vi.mock("@/server/services/health.service", () => ({
  healthService: { checkReadiness: vi.fn() },
}));

const checkReadiness = vi.mocked(healthService.checkReadiness);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/health (readiness)", () => {
  it("returns 200 / status ok with build info when the DB is up", async () => {
    checkReadiness.mockResolvedValue({
      db: "up",
      version: "1.2.3",
      commit: "abc1234",
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      status: "ok",
      db: "up",
      version: "1.2.3",
      commit: "abc1234",
    });
    expect(typeof body.timestamp).toBe("string");
  });

  it("returns 503 / status degraded when the DB is down", async () => {
    checkReadiness.mockResolvedValue({
      db: "down",
      version: "1.2.3",
      commit: undefined,
    });

    const response = await GET();

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ status: "degraded", db: "down" });
  });
});
