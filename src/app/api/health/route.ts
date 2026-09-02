import { NextResponse } from "next/server";
import { healthService } from "@/server/services/health.service";

// Readiness pings the DB on every request; never prerender or cache it (and the
// CI build has no database, so a build-time evaluation would fail here anyway).
export const dynamic = "force-dynamic";

/**
 * Readiness probe — is this instance ready to serve traffic? Delegates to the
 * service (which pings the DB through the repository) and maps the result to a
 * status code: 200 when the DB is up, 503 (`status: "degraded"`) when it's
 * down, so a load balancer pulls the instance out of rotation. The process may
 * still be alive when this fails — that's `GET /api/health/live`.
 */
export async function GET() {
  const { db, version, commit } = await healthService.checkReadiness();
  const ready = db === "up";
  return NextResponse.json(
    {
      status: ready ? "ok" : "degraded",
      db,
      version,
      commit,
      timestamp: new Date().toISOString(),
    },
    {
      status: ready ? 200 : 503,
      // Never let an edge/CDN serve a cached "ok" while the DB is actually down —
      // a stale readiness answer is a dishonest one. (`force-dynamic` only stops
      // Next-level caching; this covers anything in front of it.)
      headers: { "cache-control": "no-store" },
    },
  );
}
