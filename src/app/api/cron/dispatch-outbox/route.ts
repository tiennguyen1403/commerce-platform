import { NextResponse } from "next/server";
import { verifyCronRequest } from "@/server/cron/verify-cron-request";
import { outboxService } from "@/server/services/outbox.service";
import { logger } from "@/server/observability/logger";

// Reads the request's Authorization header and writes to the DB (the outbox
// drain), so it must never be cached or prerendered — a cron endpoint has to run
// fresh on every hit. Reading `request` already forces dynamic; this makes the
// never-cache intent explicit (and mirrors the health routes).
export const dynamic = "force-dynamic";

// Batch work can run longer than an interactive request. Vercel reads this from
// the build output to raise the function's execution ceiling (seconds); 60 is the
// Hobby-plan maximum. The drain is still batch-bounded in code (issue #30).
export const maxDuration = 60;

// No `runtime` export: Node is Next 16's default and the Edge Runtime is
// deprecated (see `src/app/api/webhooks/stripe/route.ts` for the doc citation).
// The outbox drain needs Node crypto + Prisma anyway.

/**
 * Cron entry point for the transactional-email **outbox drain** (issue #30).
 *
 * Authenticates the caller, then `outboxService.drain()` recovers stale claims,
 * selects the `PENDING` rows whose backoff has elapsed, and sends each with an
 * atomic claim + idempotency key so nothing is sent twice. Its per-run counts are
 * returned in the body for observability.
 *
 * Cron delivery is best-effort and never retried by Vercel, so the drain is
 * reconciliation-based: a missed or duplicated run is a safe no-op (the next run
 * picks up whatever is still due). A drain error propagates — the caller sees a
 * non-2xx (the GitHub workflow goes red) and `onRequestError` reports it — and
 * the next scheduled run reconciles.
 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!verifyCronRequest(request)) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  const log = logger.child({ component: "cron:dispatch-outbox" });
  const result = await outboxService.drain();
  log.info(result, "cron dispatch-outbox: drained");

  return NextResponse.json(
    { ok: true, task: "dispatch-outbox", ...result },
    { headers: { "cache-control": "no-store" } },
  );
}
