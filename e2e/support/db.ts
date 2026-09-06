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

// --- Onboarding (self-serve store creation) ---------------------------------
//
// The onboarding spec checks the outcome `createStore` produces — a tenant and
// its OWNER membership — straight from Postgres. Unlike the checkout reads above
// these aren't scoped to the demo store: onboarding mints a brand-new tenant,
// looked up by the unique slug the run chose.

/**
 * The store an onboarding run created, by its unique slug. Selects its identity
 * (`id`, `slug`) and `name` — the spec looks up the OWNER membership by `id` and
 * asserts the store's `name`. Throws if none exists: the browser only reaches
 * `/admin/<slug>` after the write, so a missing row is a real failure, not an
 * empty state.
 */
export function readTenantBySlug(slug: string) {
  return db().tenant.findUniqueOrThrow({
    where: { slug },
    select: { id: true, slug: true, name: true },
  });
}

/**
 * The account a sign-up created, by its unique email — the spec needs its id to
 * look up the OWNER membership below. Throws if none: sign-up persists the user
 * before the store write that follows, so a missing row is a real failure.
 */
export function readUserByEmail(email: string) {
  return db().user.findUniqueOrThrow({
    where: { email },
    select: { id: true, email: true },
  });
}

/**
 * The membership binding a user to a tenant (the `@@unique([userId, tenantId])`
 * pair). The spec asserts it exists with role OWNER — proof self-serve
 * onboarding made the creator the store's owner alongside the store itself.
 * Throws if none.
 */
export function readMembership(tenantId: string, userId: string) {
  return db().membership.findUniqueOrThrow({
    where: { userId_tenantId: { userId, tenantId } },
    select: { role: true, tenantId: true, userId: true },
  });
}

/**
 * Delete every artifact an onboarding run creates, matched by the shared test
 * prefix (see `onboarding.spec.ts`): the stores and the accounts. Deleting a
 * tenant cascades its membership (`Membership.tenant` is `onDelete: Cascade`);
 * deleting a user cascades its sessions, accounts, and any membership too — so
 * this pair is FK-safe in either order and leaves nothing orphaned. `deleteMany`
 * is a no-op when nothing matches, so it runs unconditionally and self-heals
 * leftovers from an earlier interrupted run.
 */
export async function deleteOnboardingArtifacts(prefix: string): Promise<void> {
  await db().tenant.deleteMany({ where: { slug: { startsWith: prefix } } });
  await db().user.deleteMany({ where: { email: { startsWith: prefix } } });
}

// --- Product images (upload→render E2E) -------------------------------------

/**
 * Delete every `ProductImage` on a seeded demo product, scoped to the demo
 * tenant. The image-upload spec uploads to a normally image-less seeded product
 * (`enamel-mug`), which — unlike the onboarding spec's throwaway tenant — is a
 * persistent seed row, so a local rerun would otherwise start with the image a
 * prior run left behind. Called from the spec's `beforeAll` (start clean, self-
 * healing an interrupted run) and `afterAll` (leave the seed as found). CI is
 * unaffected either way: it reseeds a throwaway database every run.
 *
 * `deleteMany` is a no-op when nothing matches. Only the DB rows are removed; the
 * on-disk bytes under `public/uploads/**` (the local mock's sink target) are
 * gitignored, dev/test-only throwaways and need no cleanup — the row is what the
 * storefront renders.
 */
export async function deleteProductImagesBySlug(
  productSlug: string,
): Promise<void> {
  await db().productImage.deleteMany({
    where: {
      product: { slug: productSlug, tenant: { slug: DEMO_TENANT_SLUG } },
    },
  });
}
