import { NextResponse } from "next/server";
import { verifyCronRequest } from "@/server/cron/verify-cron-request";
import { fulfillmentService } from "@/server/services/fulfillment.service";
import { logger } from "@/server/observability/logger";

// Reads the request's Authorization header and writes to the DB (reconciling
// shipped orders), so it must never be cached or prerendered — a cron endpoint has
// to run fresh on every hit. Reading `request` already forces dynamic; this makes
// the never-cache intent explicit (and mirrors the other cron routes).
export const dynamic = "force-dynamic";

// Batch work can run longer than an interactive request. Vercel reads this from
// the build output to raise the function's execution ceiling (seconds); 60 is the
// Hobby-plan maximum. The poll is still batch- and time-bounded in code
// (fulfillmentService.pollOpenShipments).
export const maxDuration = 60;

// No `runtime` export: Node is Next 16's default and the Edge Runtime is
// deprecated (see `src/app/api/webhooks/stripe/route.ts` for the doc citation).
// The poll needs Node + Prisma anyway.

/**
 * Cron entry point for the **poll-fulfillment reconciliation** (issue #140).
 *
 * Authenticates the caller, then `fulfillmentService.pollOpenShipments()` finds
 * SUBMITTED (still PAID) orders across all tenants, asks the provider for each
 * one's tracking, and for the shipped ones flips the order PAID → FULFILLED with
 * tracking persisted and the shipping-confirmation email enqueued — idempotently.
 * Its per-run counts are returned in the body for observability.
 *
 * Cron delivery is best-effort and never retried by Vercel, so the poll is
 * reconciliation-based: a missed or duplicated run is a safe no-op (the next run
 * picks up whatever is still open). A poll error propagates — the caller sees a
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

  const log = logger.child({ component: "cron:poll-fulfillment" });
  const result = await fulfillmentService.pollOpenShipments();
  log.info(result, "cron poll-fulfillment: reconciled open shipments");

  return NextResponse.json(
    { ok: true, task: "poll-fulfillment", ...result },
    { headers: { "cache-control": "no-store" } },
  );
}
