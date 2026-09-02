import { NextResponse } from "next/server";
import { verifyCronRequest } from "@/server/cron/verify-cron-request";
import { orderService } from "@/server/services/order.service";
import { logger } from "@/server/observability/logger";

// Reads the request's Authorization header and writes to the DB (cancelling stale
// orders), so it must never be cached or prerendered — a cron endpoint has to run
// fresh on every hit. Reading `request` already forces dynamic; this makes the
// never-cache intent explicit (and mirrors the health routes).
export const dynamic = "force-dynamic";

// Batch work can run longer than an interactive request. Vercel reads this from
// the build output to raise the function's execution ceiling (seconds); 60 is the
// Hobby-plan maximum. The sweep is still batch- and time-bounded in code
// (orderService.sweepAbandonedPending).
export const maxDuration = 60;

// No `runtime` export: Node is Next 16's default and the Edge Runtime is
// deprecated (see `src/app/api/webhooks/stripe/route.ts` for the doc citation).
// The sweep needs Node + Prisma anyway.

/**
 * Cron entry point for the **abandoned-PENDING-order sweep** (issue #25).
 *
 * Authenticates the caller, then `orderService.sweepAbandonedPending()` finds
 * `PENDING` orders past their grace window and, for each still-uncharged one,
 * cancels its PaymentIntent and moves the order PENDING → CANCELLED (releasing the
 * inventory hold) — so the DB and Stripe dashboard don't accumulate orphan
 * checkouts. Its per-run counts are returned in the body for observability.
 *
 * Cron delivery is best-effort and never retried by Vercel, so the sweep is
 * reconciliation-based: a missed or duplicated run is a safe no-op (the next run
 * picks up whatever is still stale). A sweep error propagates — the caller sees a
 * non-2xx (the GitHub workflow goes red) and `onRequestError` reports it — and the
 * next scheduled run reconciles.
 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!verifyCronRequest(request)) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  const log = logger.child({ component: "cron:sweep-orders" });
  const result = await orderService.sweepAbandonedPending();
  log.info(result, "cron sweep-orders: swept abandoned PENDING orders");

  return NextResponse.json(
    { ok: true, task: "sweep-orders", ...result },
    { headers: { "cache-control": "no-store" } },
  );
}
