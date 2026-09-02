import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import pkg from "../../../package.json";
import { healthRepository } from "@/server/repositories/health.repository";
import { healthService } from "@/server/services/health.service";

/**
 * Unit tests for the health service, with the repository and logger mocked. The
 * service owns two jobs: assembling build info (version + short commit, read ad
 * hoc from `process.env`) and turning a DB ping into a readiness snapshot that
 * never throws — a down DB is a normal `db: "down"` outcome, logged structured
 * (not routed to `reportError`, which would spam the alert channel per probe).
 */

vi.mock("@/server/repositories/health.repository", () => ({
  healthRepository: { ping: vi.fn() },
}));

// Spy on the structured logger; mocking the alias also intercepts the relative
// `./logger` import inside the service (both resolve to the same file).
const { errorMock } = vi.hoisted(() => ({ errorMock: vi.fn() }));
vi.mock("@/server/observability/logger", () => ({
  logger: { error: errorMock },
}));

const ping = vi.mocked(healthRepository.ping);

// Tests mutate `process.env.VERCEL_GIT_COMMIT_SHA` directly for determinism;
// capture and restore the ambient value so a machine that happens to set it
// (a Vercel shell) can't bleed into — or be clobbered by — these tests.
const ORIGINAL_SHA = process.env.VERCEL_GIT_COMMIT_SHA;

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  if (ORIGINAL_SHA === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
  else process.env.VERCEL_GIT_COMMIT_SHA = ORIGINAL_SHA;
});

describe("healthService.getBuildInfo", () => {
  it("reports the version from package.json", () => {
    expect(healthService.getBuildInfo().version).toBe(pkg.version);
  });

  it("shortens VERCEL_GIT_COMMIT_SHA to a 7-char commit", () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "abcdef1234567890";
    expect(healthService.getBuildInfo().commit).toBe("abcdef1");
  });

  it("reports an undefined commit when the SHA is unset (local / CI)", () => {
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    expect(healthService.getBuildInfo().commit).toBeUndefined();
  });

  it("reports an undefined commit when the SHA is set but blank", () => {
    // Folded to undefined so the response omits `commit` rather than sending "".
    process.env.VERCEL_GIT_COMMIT_SHA = "";
    expect(healthService.getBuildInfo().commit).toBeUndefined();
  });
});

describe("healthService.checkReadiness", () => {
  it("returns db 'up' with build info and does not log when the DB answers", async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "abcdef1234567";
    ping.mockResolvedValue(undefined);

    const result = await healthService.checkReadiness();

    expect(result).toEqual({
      version: pkg.version,
      commit: "abcdef1",
      db: "up",
    });
    expect(ping).toHaveBeenCalledTimes(1);
    expect(errorMock).not.toHaveBeenCalled();
  });

  it("returns db 'down' (never throws) and logs structured when the DB is unreachable", async () => {
    const dbError = new Error("ECONNREFUSED");
    ping.mockRejectedValue(dbError);

    const result = await healthService.checkReadiness();

    // Never throws; still reports build info alongside the down signal.
    expect(result.db).toBe("down");
    expect(result.version).toBe(pkg.version);
    // Logged once, structured, with the DB error and route tag.
    expect(errorMock).toHaveBeenCalledTimes(1);
    const [payload, message] = errorMock.mock.calls[0];
    expect(payload).toMatchObject({ err: dbError, route: "/api/health" });
    expect(message).toContain("database unreachable");
  });
});
