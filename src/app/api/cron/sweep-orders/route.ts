import { NextResponse } from "next/server";
import { verifyCronRequest } from "@/server/cron/verify-cron-request";
import { logger } from "@/server/observability/logger";

// Reads the request's Authorization header (and, once #25 lands, writes to the
// DB), so it must never be cached or prerendered — a cron endpoint has to run
// fresh on every hit. Reading `request` already forces dynamic; this makes the
// never-cache intent explicit (and mirrors the health routes).
export const dynamic = "force-dynamic";

// Batch work can run longer than an interactive request. Vercel reads this from
// the build output to raise the function's execution ceiling (seconds); 60 is the
// Hobby-plan maximum. The sweep is still batch-bounded in code (issue #25).
export const maxDuration = 60;

// No `runtime` export: Node is Next 16's default and the Edge Runtime is
// deprecated (see `src/app/api/webhooks/stripe/route.ts` for the doc citation).
// The sweep needs Node + Prisma anyway.

/**
 * Cron entry point for the **PENDING order sweep** — expire or reconcile orders
 * that were created at checkout but never confirmed as paid.
 *
 * Harness only (issue #53): authenticate the caller, log, and return a bounded
 * no-op so both schedulers get a clean 200. The real work — find stale `PENDING`
 * orders past their grace window and transition them — lands in #25, where the
 * sweep service will be called here and its counts returned in `result`.
 *
 * Cron delivery is best-effort and never retried by Vercel, so the eventual sweep
 * is reconciliation-based: a missed or duplicated run is a safe no-op.
 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!verifyCronRequest(request)) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  const log = logger.child({ component: "cron:sweep-orders" });
  // Placeholder until #25 — nothing to sweep yet.
  const result = { swept: 0 };
  log.info(result, "cron sweep-orders: no-op (PENDING sweep lands in #25)");

  return NextResponse.json(
    { ok: true, task: "sweep-orders", ...result },
    { headers: { "cache-control": "no-store" } },
  );
}
