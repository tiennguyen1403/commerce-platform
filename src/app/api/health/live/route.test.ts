import { describe, it, expect, beforeEach, vi } from "vitest";
import { healthService } from "@/server/services/health.service";
import { GET } from "@/app/api/health/live/route";

/**
 * Route test for the liveness probe, with the service mocked. Liveness must
 * never touch the DB (an orchestrator uses it to decide restarts, not rotation),
 * so this confirms the route reads only build info, never calls the readiness
 * ping, and always answers 200 with a fresh timestamp.
 */

vi.mock("@/server/services/health.service", () => ({
  healthService: { getBuildInfo: vi.fn(), checkReadiness: vi.fn() },
}));

const getBuildInfo = vi.mocked(healthService.getBuildInfo);
const checkReadiness = vi.mocked(healthService.checkReadiness);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/health/live (liveness)", () => {
  it("returns 200 / status ok with build info, without touching the DB", async () => {
    getBuildInfo.mockReturnValue({ version: "1.2.3", commit: "abc1234" });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      status: "ok",
      version: "1.2.3",
      commit: "abc1234",
    });
    expect(typeof body.timestamp).toBe("string");
    // The whole point of liveness: no readiness DB ping.
    expect(checkReadiness).not.toHaveBeenCalled();
  });
});
