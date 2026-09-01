import { randomUUID } from "node:crypto";
import { prisma } from "@/server/db";

/**
 * Shared setup/teardown for repository *integration* tests — the `*.integration.
 * test.ts` suites that run against a real Postgres (the `integration` Vitest
 * project). Not a test file itself (the name matches no `include` glob), so it is
 * never collected as a suite.
 *
 * Isolation is by tenant, not by truncation: every business table is
 * `tenantId`-scoped, so each test works inside its own throwaway `Tenant` and can
 * never see another test's rows. `deleteTenantDeep` then removes only that
 * tenant's data — targeted, so it's safe to run against a shared local database
 * and against parallel work on other tenants.
 *
 * These suites — uniquely in `src/**` — talk to Prisma directly (not through a
 * repository): seeding fixtures and reading back committed state is the test's
 * own job, and the "Prisma only in repositories" rule governs the app, not the
 * harness. The repository is still the only *subject under test*.
 *
 * Running locally: Vitest does not load `.env`, and the fallback in
 * `vitest.setup.ts` points at `localhost:5432`, which is NOT this project's local
 * database. Export the real URL first, e.g.
 *   DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/dropshipping?schema=public" pnpm test:integration
 */

export { prisma };

/** A collision-proof identifier for unique columns (`Tenant.slug`,
 *  `Order.orderNumber`, per-product SKUs, PaymentIntent ids …). */
export function uniqueId(prefix = "it"): string {
  return `${prefix}_${randomUUID()}`;
}

/** Create a fresh, isolated tenant for one test. Callers should register its id
 *  for `deleteTenantDeep` in an `afterEach` (see the suites). */
export function createTestTenant(
  overrides: { name?: string; currency?: string } = {},
) {
  return prisma.tenant.create({
    data: {
      slug: uniqueId("tenant"),
      name: overrides.name ?? "Test Store",
      ...(overrides.currency ? { currency: overrides.currency } : {}),
    },
  });
}

/**
 * Remove a tenant and everything under it. Deletes children before parents so a
 * `ProductVariant` is never removed while an `OrderItem` still references it
 * (`OrderItem.variant` is `onDelete: Restrict`, and Postgres does not guarantee
 * the ordering of cascades arriving via two different FK paths — Tenant→Order→
 * OrderItem vs Tenant→Product→ProductVariant — so a bare `tenant.delete()` can
 * trip that restriction). Scoped to the one tenant: this is cleanup, not a
 * table truncation.
 */
export async function deleteTenantDeep(tenantId: string): Promise<void> {
  await prisma.orderItem.deleteMany({ where: { order: { tenantId } } });
  await prisma.order.deleteMany({ where: { tenantId } });
  await prisma.productVariant.deleteMany({ where: { product: { tenantId } } });
  await prisma.product.deleteMany({ where: { tenantId } });
  await prisma.tenant.delete({ where: { id: tenantId } });
}

/**
 * Poll `pg_locks` until at least one lock request is waiting (`NOT granted`) —
 * i.e. some statement is blocked behind another transaction's row lock. Used by
 * the concurrency backstop test to know a `deleteMany` has parked on a `FOR
 * UPDATE` barrier before releasing it. Relies on the integration project running
 * serially (`--no-file-parallelism`), so the only contention on the database is
 * the one the test deliberately created.
 */
export async function waitForBlockedLock(timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted
    `;
    if (waiting > 0) return;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for a blocked lock");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
