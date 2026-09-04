import { NextResponse } from "next/server";
import { verifyCronRequest } from "@/server/cron/verify-cron-request";
import { fulfillmentService } from "@/server/services/fulfillment.service";
import { outboxService } from "@/server/services/outbox.service";
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

// Wall-clock ceiling for the whole request, a margin under `maxDuration` (60s). The
// poll phase has its own 45s budget (`POLL_TIME_BUDGET_MS`); this bounds the
// immediate shipping-email dispatch that follows so a large shipping burst — e.g.
// the Vercel-only daily backstop reconciling a full day of shipments at once — can't
// push the request past `maxDuration` (a Vercel timeout, or the GitHub cron's
// `curl -m 70` tripping the job red). One in-flight send can still run ~5s
// (`SEND_TIMEOUT_MS`) past this, comfortably under 60s. Overflow falls to the
// durable outbox drain — the immediate send is only a latency optimization.
const REQUEST_TIME_BUDGET_MS = 52_000;

/**
 * Cron entry point for the **poll-fulfillment reconciliation** (issue #140).
 *
 * Authenticates the caller, then `fulfillmentService.pollOpenShipments()` finds
 * SUBMITTED (still PAID) orders across all tenants, asks the provider for each
 * one's tracking, and for the shipped ones flips the order PAID → FULFILLED with
 * tracking persisted and the shipping-confirmation email enqueued — idempotently.
 * For every order reconciled this run it then fires an immediate best-effort
 * shipping-email dispatch (the same latency optimization the Stripe webhook does
 * after PAID, #139): without it an email enqueued by a poll run would wait for the
 * next cron tick's outbox drain — ~10 min under the primary GitHub Actions cron
 * (`.github/workflows/cron.yml`, which drains every tick), up to ~a day if only the
 * Vercel daily backstop is active. Its per-run counts are returned in the body for
 * observability.
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

  const started = Date.now();
  const log = logger.child({ component: "cron:poll-fulfillment" });
  const { shippedOrders, ...counts } =
    await fulfillmentService.pollOpenShipments();
  log.info(counts, "cron poll-fulfillment: reconciled open shipments");

  // Immediate best-effort shipping-email dispatch for the orders just reconciled to
  // SHIPPED — the message is already durably queued (in the reconcile transaction)
  // and the outbox drain is the safety net, so this is pure latency optimization,
  // mirroring the Stripe webhook's `dispatchForOrder` after PAID (#139).
  // `dispatchForOrder` never throws and each send is bounded, so it can't fail the
  // poll; if the run is force-killed mid-dispatch, the stranded claim is reclaimed by
  // stale-claim recovery. Bounded by the request time budget so a large shipping
  // burst can't push the run past `maxDuration`; whatever isn't reached this run
  // simply drains on the next outbox run (the durable path).
  const dispatchDeadline = started + REQUEST_TIME_BUDGET_MS;
  let dispatched = 0;
  for (const { tenantId, orderId } of shippedOrders) {
    if (Date.now() >= dispatchDeadline) {
      log.info(
        { dispatched, remaining: shippedOrders.length - dispatched },
        "cron poll-fulfillment: dispatch time budget reached — remaining shipping emails left to the outbox drain",
      );
      break;
    }
    await outboxService.dispatchForOrder(tenantId, orderId);
    dispatched += 1;
  }

  return NextResponse.json(
    { ok: true, task: "poll-fulfillment", ...counts },
    { headers: { "cache-control": "no-store" } },
  );
}
