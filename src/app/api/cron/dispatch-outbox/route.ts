import { NextResponse } from "next/server";
import { verifyCronRequest } from "@/server/cron/verify-cron-request";
import { logger } from "@/server/observability/logger";

// Reads the request's Authorization header (and, once #30 lands, writes to the
// DB), so it must never be cached or prerendered — a cron endpoint has to run
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
 * Cron entry point for the transactional-email **outbox drain**.
 *
 * Harness only (issue #53): authenticate the caller, log, and return a bounded
 * no-op so both schedulers get a clean 200. The real work — recover stale claims,
 * select `PENDING` rows, send with backoff — lands in #30, where
 * `outboxService.drain()` will be called here and its counts returned in `result`.
 *
 * Cron delivery is best-effort and never retried by Vercel, so the eventual drain
 * is reconciliation-based: a missed or duplicated run is a safe no-op.
 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!verifyCronRequest(request)) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  const log = logger.child({ component: "cron:dispatch-outbox" });
  // Placeholder until #30 — nothing to drain yet.
  const result = { processed: 0 };
  log.info(result, "cron dispatch-outbox: no-op (outbox drain lands in #30)");

  return NextResponse.json(
    { ok: true, task: "dispatch-outbox", ...result },
    { headers: { "cache-control": "no-store" } },
  );
}
