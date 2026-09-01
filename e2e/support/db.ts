import { PrismaClient } from "@prisma/client";

/**
 * A dedicated Prisma client for E2E assertions. The checkout spec reads the
 * database directly to verify server-side state the UI doesn't fully expose — an
 * order's status and a variant's stock. This is test infrastructure: the
 * "repositories-only" layering rule (CLAUDE.md) governs `src/**`, not `e2e/**`.
 *
 * We deliberately never import `@/server/db` here: that module is `server-only`
 * and throws unless the runtime resolves the `react-server` export condition, which
 * Playwright's plain-Node test runner doesn't set. A standalone client also keeps
 * the test's reads isolated from the app server's connection pool.
 *
 * `DATABASE_URL` must be present in the test process's env (the CI `e2e` job sets it
 * at the job level; locally, export it before `pnpm test:e2e`).
 */

// The seeded demo store's slug. Inlined rather than imported from
// `src/config/constants.ts` to match this directory's convention (see
// `seeded-admin.ts`) and keep `e2e/**` clear of src's `server-only` modules — keep
// it in lockstep with `DEMO_TENANT_SLUG` there.
const DEMO_TENANT_SLUG = "demo";

let client: PrismaClient | null = null;

/** The lazily-created, shared client. Disconnected in the spec's `afterAll`. */
export function db(): PrismaClient {
  return (client ??= new PrismaClient());
}

export async function disconnectDb(): Promise<void> {
  await client?.$disconnect();
  client = null;
}

/**
 * A seeded variant by SKU, scoped to the demo store, selecting the inventory
 * fields the checkout assertions compare before and after the webhook. Throws if
 * the seed is missing (a misconfigured run, not a soft "no rows").
 */
export function readVariantBySku(sku: string) {
  return db().productVariant.findFirstOrThrow({
    where: { sku, product: { tenant: { slug: DEMO_TENANT_SLUG } } },
    select: {
      id: true,
      sku: true,
      stock: true,
      reserved: true,
      priceCents: true,
    },
  });
}

/**
 * The order Stripe's checkout created for this PaymentIntent, scoped to the demo
 * store, with its line items. Throws if none matches (the order is written before
 * the browser can confirm, so a missing one is a real failure, not an empty state).
 */
export function readOrderByPaymentIntent(paymentIntentId: string) {
  return db().order.findFirstOrThrow({
    where: {
      stripePaymentIntentId: paymentIntentId,
      tenant: { slug: DEMO_TENANT_SLUG },
    },
    include: { items: true },
  });
}
