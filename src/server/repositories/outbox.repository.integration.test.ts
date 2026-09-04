import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { OutboxStatus } from "@prisma/client";
import { outboxRepository } from "@/server/repositories/outbox.repository";
import {
  createTestTenant,
  deleteTenantDeep,
  prisma,
  uniqueId,
} from "@/test/integration-db";

/**
 * Integration tests for the outbox drain's data access against a real Postgres.
 * The claim's guarantee — of two racing drainers, exactly one takes a message —
 * lives in the database's row lock plus the status-guarded `updateMany`, not in
 * the code, so (like the mark-paid tests) it can only be proven here, not with a
 * mock. Also covers the due-selection filters, stale-claim recovery, the
 * SENDING-guarded settles, and the unique-idempotencyKey enqueue backstop.
 *
 * `recoverStaleClaims` and `findDue` are platform-wide (not tenant-scoped), so
 * their assertions below tolerate other tenants' rows (subset/relative-order
 * checks, not exact equality). That the `integration` project runs serially
 * (`--no-file-parallelism`, package.json) means in practice only this test's own
 * rows are present, but the assertions don't rely on it.
 */

const tenantIds: string[] = [];
async function freshTenant() {
  const tenant = await createTestTenant();
  tenantIds.push(tenant.id);
  return tenant;
}

afterEach(async () => {
  await Promise.all(tenantIds.splice(0).map(deleteTenantDeep));
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** A minimal order for an outbox row to reference (the FK requires a real one). */
function seedOrder(tenantId: string) {
  return prisma.order.create({
    data: {
      tenantId,
      orderNumber: uniqueId("order"),
      status: "PAID",
      email: "shopper@example.com",
      totalCents: 1000,
      currency: "usd",
      stripePaymentIntentId: uniqueId("pi"),
    },
  });
}

type OutboxOverrides = {
  status?: OutboxStatus;
  attempts?: number;
  nextAttemptAt?: Date;
  claimedAt?: Date | null;
};

function seedOutbox(
  tenantId: string,
  orderId: string,
  o: OutboxOverrides = {},
) {
  return prisma.outboxMessage.create({
    data: {
      tenantId,
      orderId,
      type: "ORDER_CONFIRMATION",
      idempotencyKey: uniqueId("oc"),
      status: o.status ?? "PENDING",
      attempts: o.attempts ?? 0,
      nextAttemptAt: o.nextAttemptAt ?? new Date(),
      claimedAt: o.claimedAt ?? null,
    },
  });
}

const past = (ms = 60_000) => new Date(Date.now() - ms);
const future = (ms = 60 * 60_000) => new Date(Date.now() + ms);
const byId = (id: string) =>
  prisma.outboxMessage.findUniqueOrThrow({ where: { id } });

describe("outboxRepository.claim (integration)", () => {
  it("is won by exactly one of two racing claims on the same PENDING row", async () => {
    const tenant = await freshTenant();
    const order = await seedOrder(tenant.id);
    const msg = await seedOutbox(tenant.id, order.id, {
      nextAttemptAt: past(),
    });

    const now = new Date();
    const [a, b] = await Promise.all([
      outboxRepository.claim(msg.id, now),
      outboxRepository.claim(msg.id, now),
    ]);

    // The row lock serializes the two guarded updates: one sees PENDING (count
    // 1), the other re-reads the now-SENDING row (count 0). Never both.
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const after = await byId(msg.id);
    expect(after.status).toBe("SENDING");
    expect(after.claimedAt).not.toBeNull();
  });

  it("won't claim a row whose backoff hasn't elapsed", async () => {
    const tenant = await freshTenant();
    const order = await seedOrder(tenant.id);
    const msg = await seedOutbox(tenant.id, order.id, {
      nextAttemptAt: future(),
    });

    const claimed = await outboxRepository.claim(msg.id, new Date());

    expect(claimed).toBe(false);
    expect((await byId(msg.id)).status).toBe("PENDING");
  });

  it("won't re-claim a row that is already SENDING", async () => {
    const tenant = await freshTenant();
    const order = await seedOrder(tenant.id);
    const msg = await seedOutbox(tenant.id, order.id, {
      status: "SENDING",
      claimedAt: new Date(),
      nextAttemptAt: past(),
    });

    expect(await outboxRepository.claim(msg.id, new Date())).toBe(false);
  });
});

describe("outboxRepository.findDue (integration)", () => {
  it("returns only PENDING, due rows, oldest-due first", async () => {
    const tenant = await freshTenant();
    const order = await seedOrder(tenant.id);

    const older = await seedOutbox(tenant.id, order.id, {
      nextAttemptAt: past(120_000),
    });
    const newer = await seedOutbox(tenant.id, order.id, {
      nextAttemptAt: past(60_000),
    });
    const notDue = await seedOutbox(tenant.id, order.id, {
      nextAttemptAt: future(),
    });
    const sending = await seedOutbox(tenant.id, order.id, {
      status: "SENDING",
      claimedAt: new Date(),
      nextAttemptAt: past(),
    });
    const sent = await seedOutbox(tenant.id, order.id, {
      status: "SENT",
      nextAttemptAt: past(),
    });
    const dead = await seedOutbox(tenant.id, order.id, {
      status: "DEAD",
      nextAttemptAt: past(),
    });

    // Large limit so this tenant's rows can't be crowded out by any others.
    const due = await outboxRepository.findDue(new Date(), 100);
    const ids = new Set(due.map((m) => m.id));

    expect(ids.has(older.id)).toBe(true);
    expect(ids.has(newer.id)).toBe(true);
    for (const excluded of [notDue, sending, sent, dead]) {
      expect(ids.has(excluded.id)).toBe(false);
    }
    // Relative order is preserved even if other tenants' rows interleave.
    const mineInOrder = due
      .map((m) => m.id)
      .filter((id) => id === older.id || id === newer.id);
    expect(mineInOrder).toEqual([older.id, newer.id]);
  });

  it("respects the limit", async () => {
    const tenant = await freshTenant();
    const order = await seedOrder(tenant.id);
    await seedOutbox(tenant.id, order.id, { nextAttemptAt: past() });
    await seedOutbox(tenant.id, order.id, { nextAttemptAt: past() });
    await seedOutbox(tenant.id, order.id, { nextAttemptAt: past() });

    // At least 3 due rows exist, so a limit of 2 must return exactly 2.
    const due = await outboxRepository.findDue(new Date(), 2);
    expect(due).toHaveLength(2);
  });
});

describe("outboxRepository.findDueForOrder (integration)", () => {
  it("returns only this order's PENDING due messages (tenant-scoped)", async () => {
    const tenant = await freshTenant();
    const other = await freshTenant();
    const order = await seedOrder(tenant.id);
    const otherOrder = await seedOrder(other.id);
    const mine = await seedOutbox(tenant.id, order.id, {
      nextAttemptAt: past(),
    });
    // A different tenant/order, and a not-due row for the same order — excluded.
    await seedOutbox(other.id, otherOrder.id, { nextAttemptAt: past() });
    await seedOutbox(tenant.id, order.id, { nextAttemptAt: future() });

    const due = await outboxRepository.findDueForOrder(
      tenant.id,
      order.id,
      new Date(),
    );

    expect(due.map((m) => m.id)).toEqual([mine.id]);
  });
});

describe("outboxRepository.recoverStaleClaims (integration)", () => {
  it("resets a stale SENDING claim to PENDING and leaves a fresh one alone", async () => {
    const tenant = await freshTenant();
    const order = await seedOrder(tenant.id);
    const stale = await seedOutbox(tenant.id, order.id, {
      status: "SENDING",
      claimedAt: past(10 * 60_000),
      attempts: 2,
    });
    const fresh = await seedOutbox(tenant.id, order.id, {
      status: "SENDING",
      claimedAt: new Date(),
    });

    const recovered = await outboxRepository.recoverStaleClaims(
      past(5 * 60_000),
    );

    expect(recovered).toBeGreaterThanOrEqual(1);
    const staleAfter = await byId(stale.id);
    expect(staleAfter.status).toBe("PENDING");
    expect(staleAfter.claimedAt).toBeNull();
    // An infra kill is not a delivery failure — the attempt budget is untouched.
    expect(staleAfter.attempts).toBe(2);
    // A still-fresh claim (a live worker) must not be stolen.
    expect((await byId(fresh.id)).status).toBe("SENDING");
  });
});

describe("outboxRepository settle guards (integration)", () => {
  it("markSent settles a SENDING row and no-ops a non-SENDING one", async () => {
    const tenant = await freshTenant();
    const order = await seedOrder(tenant.id);
    const sending = await seedOutbox(tenant.id, order.id, {
      status: "SENDING",
      claimedAt: new Date(),
    });
    const pending = await seedOutbox(tenant.id, order.id, {
      status: "PENDING",
    });

    await outboxRepository.markSent(sending.id);
    await outboxRepository.markSent(pending.id); // guarded → no-op

    expect((await byId(sending.id)).status).toBe("SENT");
    expect((await byId(pending.id)).status).toBe("PENDING");
  });

  it("reschedule bumps attempts, pushes nextAttemptAt, and releases the claim", async () => {
    const tenant = await freshTenant();
    const order = await seedOrder(tenant.id);
    const msg = await seedOutbox(tenant.id, order.id, {
      status: "SENDING",
      claimedAt: new Date(),
      attempts: 1,
    });

    const next = future(120_000);
    await outboxRepository.reschedule(msg.id, next, "Error: boom");

    const after = await byId(msg.id);
    expect(after.status).toBe("PENDING");
    expect(after.attempts).toBe(2);
    expect(after.claimedAt).toBeNull();
    expect(after.lastError).toBe("Error: boom");
    expect(after.nextAttemptAt.getTime()).toBe(next.getTime());
  });

  it("markDead bumps the final attempt and is terminal", async () => {
    const tenant = await freshTenant();
    const order = await seedOrder(tenant.id);
    const msg = await seedOutbox(tenant.id, order.id, {
      status: "SENDING",
      claimedAt: new Date(),
      attempts: 9,
    });

    await outboxRepository.markDead(msg.id, "Error: exhausted");

    const after = await byId(msg.id);
    expect(after.status).toBe("DEAD");
    expect(after.attempts).toBe(10);
    expect(after.claimedAt).toBeNull();
    expect(after.lastError).toBe("Error: exhausted");
  });
});

describe("OutboxMessage idempotencyKey constraint (integration)", () => {
  it("rejects a second row with the same idempotencyKey", async () => {
    const tenant = await freshTenant();
    const order = await seedOrder(tenant.id);
    const key = uniqueId("oc");

    const create = () =>
      prisma.outboxMessage.create({
        data: {
          tenantId: tenant.id,
          orderId: order.id,
          type: "ORDER_CONFIRMATION",
          idempotencyKey: key,
        },
      });

    await create();
    // The belt-and-suspenders behind the in-transaction enqueue: even if a second
    // enqueue were ever attempted, the unique constraint (P2002) blocks it.
    await expect(create()).rejects.toMatchObject({ code: "P2002" });
  });
});
