import "server-only";
import pkg from "../../../package.json";
import { healthRepository } from "@/server/repositories/health.repository";
import { logger } from "@/server/observability/logger";

/** Deploy identity returned by both probes. */
export type BuildInfo = {
  /** App version, from `package.json`. */
  version: string;
  /** Short git SHA on Vercel; `undefined` locally / in CI (key then omitted). */
  commit: string | undefined;
};

/** Readiness snapshot: build identity plus current DB reachability. */
export type ReadinessResult = BuildInfo & {
  db: "up" | "down";
};

/**
 * Build info is read *ad hoc* — `package.json`'s version plus Vercel's
 * `VERCEL_GIT_COMMIT_SHA` straight from `process.env`, deliberately NOT through
 * `@/lib/env`. That module validates-or-throws at boot; the commit SHA exists
 * only on a Vercel deploy, so routing it through the strict schema would crash
 * every local/CI boot over a value that merely labels a health response.
 */
function getBuildInfo(): BuildInfo {
  return {
    version: pkg.version,
    // 7 chars is the conventional short SHA. `|| undefined` folds both unset and
    // set-but-blank to `undefined` so the response omits `commit` in either case
    // (mirrors how `env.ts` treats a blank var), never emitting `commit: ""`.
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || undefined,
  };
}

/**
 * Health logic for the two probes. Keeps Prisma out of the route (golden rule
 * #2): the route calls this service, the service calls the repository.
 */
export const healthService = {
  getBuildInfo,

  /**
   * Readiness: is the app ready to serve traffic? Pings the DB and folds the
   * outcome into a snapshot with build info. Never throws — a down database is
   * a normal readiness *outcome* (`db: "down"`, which the route maps to 503),
   * not an exceptional flow.
   */
  async checkReadiness(): Promise<ReadinessResult> {
    const build = getBuildInfo();
    try {
      await healthRepository.ping();
      return { ...build, db: "up" };
    } catch (error) {
      // A DB blip flips readiness to 503 — the signal an uptime monitor already
      // watches — so log it structured rather than routing it to `reportError`,
      // which would fan every probe failure out to the alert channel for the
      // duration of an outage.
      logger.error(
        { err: error, route: "/api/health" },
        "readiness check failed: database unreachable",
      );
      return { ...build, db: "down" };
    }
  },
};
