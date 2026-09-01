import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { logger } from "@/server/observability/logger";

export const dynamic = "force-dynamic";

/** Liveness + database connectivity probe. */
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({
      status: "ok",
      db: "up",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    // Readiness probe: a DB blip flips this to 503 — the signal an uptime monitor
    // already watches — so log it structured rather than routing it to
    // `reportError`, which would fan every probe failure out to the alert channel
    // for the duration of an outage.
    logger.error(
      { err: error, route: "/api/health" },
      "health check failed: database unreachable",
    );
    return NextResponse.json(
      { status: "degraded", db: "down" },
      { status: 503 },
    );
  }
}
