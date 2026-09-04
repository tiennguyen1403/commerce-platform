import "server-only";
import type { OutboxMessageType, Prisma } from "@prisma/client";
import { prisma } from "@/server/db";

/**
 * Data-access for the transactional-email outbox (#30). The one place that
 * *enqueues* a row is `orderRepository.markPaidByPaymentIntent` — it must write
 * the row inside the PENDING → PAID transaction to be atomic, so it does so via
 * that transaction's client, not through here. Everything in this module is the
 * *drain* side (select → claim → settle), and it is the only place those queries
 * touch Prisma.
 *
 * The claim is the same idempotency idiom as `markPaidByPaymentIntent`'s status
 * guard: a status-guarded `updateMany` under READ COMMITTED. The row locks on
 * UPDATE, so of two racing callers exactly one still sees `status: "PENDING"` and
 * gets count 1; the other re-reads the now-`SENDING` row, matches nothing, and
 * gets count 0. That — not a lock table — is what stops two drain runs (or a
 * drain racing the webhook's immediate dispatch) from sending one message twice.
 *
 * Tenancy note: the cron drain is a **platform-wide** job, so `recoverStaleClaims`
 * and `findDue` deliberately query across all tenants — the one intentional
 * exception to golden rule #1's tenant scoping. There is no leakage: each row
 * carries its `tenantId`, and the drain renders every message through the
 * tenant-scoped `orderRepository.findByIdForTenant(message.tenantId, …)`. The
 * remaining methods key by the globally-unique primary key, which is tenant-safe.
 */

/** Just the fields the drain needs to send one message — never the whole row. */
export type OutboxMessageSummary = {
  id: string;
  tenantId: string;
  type: OutboxMessageType;
  orderId: string;
  idempotencyKey: string;
  attempts: number;
};

const summarySelect = {
  id: true,
  tenantId: true,
  type: true,
  orderId: true,
  idempotencyKey: true,
  attempts: true,
} satisfies Prisma.OutboxMessageSelect;

export const outboxRepository = {
  /**
   * Return claims abandoned by a crashed/killed worker to `PENDING`: any
   * `SENDING` row whose claim was taken before `staleBefore`. `attempts` is left
   * untouched — an infra kill is not a delivery failure. The caller must pick
   * `staleBefore` so it is always older than the drain route's `maxDuration`, so
   * a *still-running* worker's claim is never reclaimed out from under it (a
   * worker is force-terminated at `maxDuration`; past that its claim is dead).
   */
  async recoverStaleClaims(staleBefore: Date): Promise<number> {
    const { count } = await prisma.outboxMessage.updateMany({
      where: { status: "SENDING", claimedAt: { lt: staleBefore } },
      data: { status: "PENDING", claimedAt: null },
    });
    return count;
  },

  /** Up to `limit` `PENDING` messages whose backoff has elapsed, oldest-due
   *  first — the cron drain's work list. */
  findDue(now: Date, limit: number): Promise<OutboxMessageSummary[]> {
    return prisma.outboxMessage.findMany({
      where: { status: "PENDING", nextAttemptAt: { lte: now } },
      orderBy: { nextAttemptAt: "asc" },
      take: limit,
      select: summarySelect,
    });
  },

  /** `PENDING`, due messages for a single order (tenant-scoped) — the webhook's
   *  immediate best-effort dispatch. Normally exactly one row. */
  findDueForOrder(
    tenantId: string,
    orderId: string,
    now: Date,
  ): Promise<OutboxMessageSummary[]> {
    return prisma.outboxMessage.findMany({
      where: {
        tenantId,
        orderId,
        status: "PENDING",
        nextAttemptAt: { lte: now },
      },
      orderBy: { nextAttemptAt: "asc" },
      select: summarySelect,
    });
  },

  /**
   * Atomically take ownership of a message to send it. Guarded on `PENDING` +
   * due, so of racing callers exactly one gets count 1 (returns `true`) and the
   * rest get 0 (`false`, skip). `now` is compared to `nextAttemptAt` so a row
   * rescheduled into the future between the caller's read and this write can't be
   * claimed early.
   */
  async claim(id: string, now: Date): Promise<boolean> {
    const { count } = await prisma.outboxMessage.updateMany({
      where: { id, status: "PENDING", nextAttemptAt: { lte: now } },
      data: { status: "SENDING", claimedAt: now },
    });
    return count === 1;
  },

  /** Settle a claimed message as delivered. Guarded on `SENDING` so a row that
   *  was stale-recovered and re-claimed by another worker is never clobbered. */
  async markSent(id: string): Promise<void> {
    await prisma.outboxMessage.updateMany({
      where: { id, status: "SENDING" },
      data: { status: "SENT", claimedAt: null, lastError: null },
    });
  },

  /** Return a claimed message to `PENDING` for a later retry (transient
   *  failure): count the attempt, push out `nextAttemptAt` (backoff), record the
   *  error, release the claim. Guarded on `SENDING`. */
  async reschedule(
    id: string,
    nextAttemptAt: Date,
    lastError: string,
  ): Promise<void> {
    await prisma.outboxMessage.updateMany({
      where: { id, status: "SENDING" },
      data: {
        status: "PENDING",
        attempts: { increment: 1 },
        nextAttemptAt,
        claimedAt: null,
        lastError,
      },
    });
  },

  /** Settle a claimed message as permanently failed — retries exhausted or a
   *  permanent error. Counts the final attempt so `attempts` reflects reality.
   *  Guarded on `SENDING`. */
  async markDead(id: string, lastError: string): Promise<void> {
    await prisma.outboxMessage.updateMany({
      where: { id, status: "SENDING" },
      data: {
        status: "DEAD",
        attempts: { increment: 1 },
        claimedAt: null,
        lastError,
      },
    });
  },

  /** Hold a claimed message PENDING for a later run WITHOUT counting an attempt —
   *  used when its `type` has no send path yet (`SHIPPING_CONFIRMATION` until the
   *  M4-08 send lands). Unlike `reschedule`, it does not increment `attempts` (a
   *  deferral is not a failed delivery, so it must never march the row toward the
   *  DEAD budget) and clears `lastError`. Releases the claim and pushes
   *  `nextAttemptAt` out so the row isn't re-claimed immediately. Guarded on
   *  `SENDING` like the other settle writes. */
  async defer(id: string, nextAttemptAt: Date): Promise<void> {
    await prisma.outboxMessage.updateMany({
      where: { id, status: "SENDING" },
      data: {
        status: "PENDING",
        nextAttemptAt,
        claimedAt: null,
        lastError: null,
      },
    });
  },
};
