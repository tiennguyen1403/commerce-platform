import { NextResponse } from "next/server";
import { healthService } from "@/server/services/health.service";

// No DB and no per-request state, but keep it dynamic so the timestamp and
// build info are evaluated fresh per request rather than frozen at build time.
export const dynamic = "force-dynamic";

/**
 * Liveness probe — is the process up and able to serve HTTP? Deliberately does
 * NOT touch the database: an orchestrator uses liveness to decide whether to
 * *restart* an instance, and a transient DB outage must not trigger a restart
 * loop (pulling the instance from rotation is readiness' job — see
 * `GET /api/health`). Answering at all means alive, so this is always 200.
 */
export async function GET() {
  const { version, commit } = healthService.getBuildInfo();
  return NextResponse.json(
    {
      status: "ok",
      version,
      commit,
      timestamp: new Date().toISOString(),
    },
    // A monitor must always reach *this* instance, never a cached 200 from an
    // edge/CDN — the point of a liveness probe is a live answer.
    { headers: { "cache-control": "no-store" } },
  );
}
