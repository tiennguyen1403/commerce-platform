import "server-only";
import {
  outboxRepository,
  type OutboxMessageSummary,
} from "@/server/repositories/outbox.repository";
import { orderRepository } from "@/server/repositories/order.repository";
import { emailService } from "@/server/services/email.service";
import { fulfillmentService } from "@/server/services/fulfillment.service";
import { EmailNotConfiguredError } from "@/server/email.errors";
import {
  FulfillmentError,
  FulfillmentNotConfiguredError,
} from "@/server/fulfillment.errors";
import { OutboxPermanentError } from "@/server/outbox.errors";
import { reportError } from "@/server/observability/error-reporter";
import { logger, type Logger } from "@/server/observability/logger";

/**
 * The outbox drain — the send-and-retry engine behind reliable order-confirmation
 * email (#30). Where the Stripe webhook once sent synchronously (at-most-once: a
 * Resend blip during the one PENDING → PAID delivery dropped the email forever),
 * the PAID transition now enqueues a durable `OutboxMessage` in the same
 * transaction and this drains it — turning delivery into at-least-once.
 *
 * Called two ways, both funnelling through the one `dispatchOne` (claim → send →
 * settle), so there is a single sending path:
 *  - `drain()` — the cron entry point (`/api/cron/dispatch-outbox`): recover
 *    stale claims, then send every due message with backoff.
 *  - `dispatchForOrder()` — the webhook's best-effort immediate send right after
 *    PAID, so the happy-path email stays instant. Delivery never hinges on it;
 *    the cron is the durable safety net.
 *
 * Exactly-once-ish delivery rests on two things: the repository's atomic **claim**
 * (only one worker sends a given row at a time — see `outbox.repository.ts`) and,
 * for the sole remaining window (a send that succeeds but whose row update is then
 * lost to a killed worker), the row's **idempotency key** passed to Resend.
 */

// --- Tuning (module-local, matching order.service's retry-knob style) --------

/** Upper bound on messages fetched per drain run. The real stop condition is the
 *  time budget below (sends run sequentially); this just caps the query so one
 *  run can't pull an unbounded backlog into memory. Whatever isn't reached drains
 *  over successive runs (reconciliation-based, so a partial run is always safe). */
const DRAIN_BATCH_SIZE = 50;

/** Soft per-run wall-clock budget. The drain stops claiming new messages once
 *  this elapses, so a slow Resend (or a big backlog) degrades into "continues
 *  next run" rather than being force-killed at the route's `maxDuration` (60s) —
 *  a kill would strand an in-flight claim and redden the GitHub cron for a run
 *  that was actually making progress. Kept comfortably under `maxDuration`. */
const DRAIN_TIME_BUDGET_MS = 45_000;

/** After this many failed send attempts a message is marked DEAD. With the
 *  backoff below this spans ~8.5h of retries (Σ 1..256 min, then capped) — enough
 *  to ride out a long Resend outage without spinning forever on a genuinely
 *  undeliverable message, and well inside Resend's 24h idempotency window. */
const MAX_SEND_ATTEMPTS = 10;

/** A `SENDING` claim older than this is treated as abandoned and reclaimed. It
 *  MUST exceed the wall-clock ceiling of every claim-holder so a still-running
 *  worker's claim is never stolen. Both holders qualify: the cron drain is capped
 *  by its route `maxDuration` (60s), and the webhook's immediate `dispatchForOrder`
 *  by its own (platform default, far under this). Past this window a claim is
 *  provably dead (its worker was force-terminated), so reclaiming is safe. */
const CLAIM_TIMEOUT_MS = 5 * 60_000;

/** Exponential backoff base and cap. */
const BACKOFF_BASE_MS = 60_000; // 1 min for the first retry
const BACKOFF_CAP_MS = 6 * 60 * 60_000; // 6 h ceiling

/** Keep `lastError` bounded — it is diagnostics, not a payload. */
const MAX_LAST_ERROR_LEN = 500;

const log = logger.child({ component: "outbox" });

/** Delay before the Nth attempt (1-based), exponential and capped. */
function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
}

function errorText(err: unknown): string {
  const text =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.slice(0, MAX_LAST_ERROR_LEN);
}

/** Per-run tallies, surfaced by the cron route for observability. */
export type DrainResult = {
  /** Stale `SENDING` claims reset to `PENDING` this run. */
  recovered: number;
  sent: number;
  /** Transient failures rescheduled for a later retry. */
  failed: number;
  /** Permanently failed (retries exhausted or a permanent error). */
  dead: number;
  /** Claims lost to a concurrent worker — a normal, benign race. */
  skipped: number;
};

type DispatchOutcome = "sent" | "failed" | "dead" | "skipped";

/** Render and send one message by type. Throws on failure so `dispatchOne` can
 *  classify it (permanent → DEAD now, transient → backoff). */
async function sendMessage(message: OutboxMessageSummary): Promise<void> {
  switch (message.type) {
    case "ORDER_CONFIRMATION": {
      // Re-read the order (its lines carry the snapshotted titles/prices the email
      // renders from), tenant-scoped. A missing order is a permanent failure:
      // orders are never deleted, and if one were the FK cascade would take this
      // row with it, so an orphan here is a data-integrity anomaly, not a passing
      // fault.
      const order = await orderRepository.findByIdForTenant(
        message.tenantId,
        message.orderId,
      );
      if (!order) {
        throw new OutboxPermanentError(
          `outbox message ${message.id} references missing order ${message.orderId}`,
        );
      }
      await emailService.sendOrderConfirmation(order, {
        idempotencyKey: message.idempotencyKey,
      });
      return;
    }
    case "FULFILLMENT_SUBMISSION":
      // Submit the paid order to the POD provider. The service owns the two-layer
      // idempotency (this message's atomic claim above is layer 1; an order-level
      // NOT_SUBMITTED → SUBMITTING guard is layer 2) and all fulfillment-state
      // persistence: it throws a permanent `FulfillmentError` (having recorded the
      // order FAILED) on a non-retryable failure, and returns on success or an
      // already-claimed order. It re-reads the fulfillment-shaped order itself, so
      // there is no order re-read here. (A missing order — impossible, the FK
      // cascade would take this row too — surfaces as its OrderNotFoundError:
      // transient, retried then DEAD.)
      await fulfillmentService.submitOrder(message.tenantId, message.orderId);
      return;
    case "SHIPPING_CONFIRMATION":
      // The shipped + tracking email — a later M4 issue. Nothing enqueues it yet,
      // so this is unreachable in practice; until its send path exists, treat it as
      // permanently undeliverable rather than silently dropping it.
      throw new OutboxPermanentError(
        `outbox message ${message.id} has no send path for type ${message.type} yet`,
      );
    default: {
      // Exhaustive: `message.type` is `never` here, so adding a new enum value
      // without a case above is a compile error, not a runtime surprise.
      const _exhaustive: never = message.type;
      throw new OutboxPermanentError(
        `outbox message ${message.id} has unknown type ${String(_exhaustive)}`,
      );
    }
  }
}

/** Settle a claimed message after a send failure: DEAD (permanent or exhausted)
 *  or rescheduled with backoff. */
async function settleFailure(
  message: OutboxMessageSummary,
  attempt: number,
  err: unknown,
  child: Logger,
): Promise<"failed" | "dead"> {
  const lastError = errorText(err);
  // Permanent = never fixed by retrying: an unconfigured/undeliverable message
  // (email or fulfillment) or a genuinely undeliverable one. Every typed
  // `FulfillmentError` qualifies (unconfigured provider, unmapped variant, missing
  // address, provider soft-rejection) — the fulfillment analogue of
  // `EmailNotConfiguredError` — so the drain dies at once instead of burning the
  // retry budget on a POD order that can never be submitted as-is.
  const permanent =
    err instanceof EmailNotConfiguredError ||
    err instanceof FulfillmentError ||
    err instanceof OutboxPermanentError;
  const exhausted = attempt >= MAX_SEND_ATTEMPTS;

  if (permanent || exhausted) {
    await outboxRepository.markDead(message.id, lastError);
    // A store that never configured Resend or a fulfillment provider is an
    // expected setup state, not an incident — warn and move on. Everything else
    // that reaches DEAD is a paid order left unconfirmed or unfulfilled (an
    // unmapped variant, a rejected submission, an exhausted retry budget): exactly
    // the silent drop #30 exists to surface, so log at error and alert durably
    // (the webhook outlives log retention).
    if (err instanceof EmailNotConfiguredError) {
      child.warn("outbox: dead — email not configured");
    } else if (err instanceof FulfillmentNotConfiguredError) {
      child.warn("outbox: dead — fulfillment not configured");
    } else {
      child.error(
        { err },
        exhausted
          ? "outbox: dead — send attempts exhausted"
          : "outbox: dead — permanent failure",
      );
      await reportError(err, {
        component: "outbox",
        messageId: message.id,
        orderId: message.orderId,
        tenantId: message.tenantId,
        attempts: attempt,
      });
    }
    return "dead";
  }

  const nextAttemptAt = new Date(Date.now() + backoffMs(attempt));
  await outboxRepository.reschedule(message.id, nextAttemptAt, lastError);
  child.warn({ err, nextAttemptAt }, "outbox: send failed — will retry");
  return "failed";
}

/**
 * Claim, send, and settle a single message. Returns the outcome; the only thing
 * it may throw on is an unexpected *database* error (the claim/settle writes),
 * which callers isolate per-message. Send failures never propagate — they are
 * classified and recorded (SENT / rescheduled / DEAD) here.
 */
async function dispatchOne(
  message: OutboxMessageSummary,
): Promise<DispatchOutcome> {
  // The atomic claim is the idempotency point: if we don't win it, another drain
  // run or the webhook's immediate dispatch owns it — skip, don't double-send.
  const claimed = await outboxRepository.claim(message.id, new Date());
  if (!claimed) return "skipped";

  // The claim doesn't touch `attempts`; a settle-failure increments it. So the
  // attempt we are about to make is number `attempts + 1`.
  const attempt = message.attempts + 1;
  const child = log.child({
    messageId: message.id,
    orderId: message.orderId,
    tenantId: message.tenantId,
    attempt,
  });

  try {
    await sendMessage(message);
  } catch (err) {
    return settleFailure(message, attempt, err, child);
  }

  // Sent. Settle outside the try so a `markSent` DB error is not mistaken for a
  // send failure: it propagates to the caller's per-message isolation, the row
  // stays SENDING, and stale-claim recovery re-drains it — where the idempotency
  // key makes the re-send a no-op at Resend.
  await outboxRepository.markSent(message.id);
  child.info("outbox: sent");
  return "sent";
}

export const outboxService = {
  /**
   * Drain the outbox: recover stale claims, then send every due message. Called
   * by the cron route. Each message is isolated so one row's unexpected DB error
   * can't abort the batch; whatever isn't settled this run is retried next run.
   */
  async drain(): Promise<DrainResult> {
    const now = new Date();
    const recovered = await outboxRepository.recoverStaleClaims(
      new Date(now.getTime() - CLAIM_TIMEOUT_MS),
    );
    const due = await outboxRepository.findDue(now, DRAIN_BATCH_SIZE);

    const result: DrainResult = {
      recovered,
      sent: 0,
      failed: 0,
      dead: 0,
      skipped: 0,
    };
    const deadline = Date.now() + DRAIN_TIME_BUDGET_MS;
    for (const message of due) {
      // Stop claiming new work once the budget is spent: better to leave the rest
      // for the next run than to be force-killed mid-send and strand a claim.
      if (Date.now() >= deadline) {
        const handled =
          result.sent + result.failed + result.dead + result.skipped;
        log.info(
          { ...result, remaining: due.length - handled },
          "outbox: drain time budget reached — remaining messages deferred to next run",
        );
        break;
      }
      try {
        result[await dispatchOne(message)] += 1;
      } catch (err) {
        // Unexpected (a DB error in claim/settle). The row is left as-is —
        // PENDING if unclaimed, else SENDING and reclaimed once its claim goes
        // stale — so nothing is lost. Log and keep draining the rest.
        log.error(
          { err, messageId: message.id, orderId: message.orderId },
          "outbox: unexpected dispatch error",
        );
      }
    }
    return result;
  },

  /**
   * Best-effort immediate dispatch of an order's queued confirmation, called from
   * the Stripe webhook right after the PAID flip so the happy-path email stays
   * instant. The message is already durably queued and the cron drain is the
   * safety net, so this is pure latency optimization: it never throws, and its
   * outcome cannot affect the webhook's 2xx.
   */
  async dispatchForOrder(tenantId: string, orderId: string): Promise<void> {
    try {
      const due = await outboxRepository.findDueForOrder(
        tenantId,
        orderId,
        new Date(),
      );
      for (const message of due) {
        await dispatchOne(message);
      }
    } catch (err) {
      log.error(
        { err, tenantId, orderId },
        "outbox: immediate dispatch failed (cron drain will retry)",
      );
    }
  },
};
