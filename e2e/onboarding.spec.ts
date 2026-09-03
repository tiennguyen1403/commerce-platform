import { test, expect } from "@playwright/test";

import {
  deleteOnboardingArtifacts,
  disconnectDb,
  readMembership,
  readTenantBySlug,
  readUserByEmail,
} from "./support/db";

/**
 * Self-serve onboarding, end to end: a brand-new visitor signs up, creates a
 * store at `/new`, and lands in that store's own admin as its OWNER.
 *
 * This is the platform's front door — the M3 exit criterion "self-serve
 * onboarding (unique subdomain, OWNER, one transaction)" — and, unlike the
 * checkout spec, it touches no third party, so it's fully deterministic. It
 * asserts BOTH ends of the flow:
 *  - the UI: the store-scoped admin chrome renders, which only happens once the
 *    per-store membership gate has admitted the new owner; and
 *  - the database: the tenant exists under the chosen slug and the creator holds
 *    an OWNER membership on it — the committed outcome of `createStore`'s tenant
 *    + owner-membership write, read straight from Postgres (a black-box read
 *    proves the outcome, not the transactionality; that's the integration
 *    tests' job).
 *
 * Isolation: every run mints a unique account + subdomain, so a Playwright retry
 * or a repeat local run never collides on the unique `email`/`slug`; `afterAll`
 * then deletes everything matched by `E2E_PREFIX`, self-healing against orphans
 * from an interrupted run. `DATABASE_URL` must be in the test process's env (the
 * CI `e2e` job sets it at the job level; locally, export it before
 * `pnpm test:e2e`).
 */

// Both the account email and the store subdomain start with this, so `afterAll`
// can sweep every artifact by prefix. It's a valid slug shape on its own
// (lowercase, hyphen-separated), so the subdomain built from it passes
// onboarding's own validation — and it's distinct from the checkout spec's
// `e2e-<ts>` order emails, so the two specs' cleanups never overlap.
const E2E_PREFIX = "e2e-onboarding-";

// Sign-up → create-store → admin render is three real navigations plus two form
// round-trips; give it headroom over the 30s default so CI latency isn't a flake.
test.setTimeout(60_000);

test.afterAll(async () => {
  // Order matters only for readability — either delete cascades the membership.
  await deleteOnboardingArtifacts(E2E_PREFIX);
  await disconnectDb();
});

test("a new user signs up, creates a store, and owns its admin", async ({
  page,
}) => {
  // Per-run identity. base36 of the clock plus a little randomness keeps the
  // email and subdomain unique even across a Playwright retry (which re-runs this
  // body), so a row left by a failed attempt can't make the retry collide on the
  // unique `email`/`slug`. base36 is all-lowercase — which keeps the slug within
  // `SLUG_PATTERN` and matches how Better Auth stores the email (normalized to
  // lowercase), so the exact-email DB lookup below resolves.
  const token = `${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const email = `${E2E_PREFIX}${token}@example.com`;
  const password = "onboard-e2e-only";
  const storeName = `E2E Onboarding ${token}`;
  const slug = `${E2E_PREFIX}${token}`;

  // 1) Sign up as a fresh owner, carrying the onboarding intent through the
  // `?redirect=/new` the real front door uses. Better Auth signs the new account
  // in immediately (autoSignIn is on), so the form forwards straight to `/new`.
  await page.goto("/sign-up?redirect=/new");
  await page.getByLabel("Name").fill(storeName);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();

  // Landing on `/new` (not bounced back to `/sign-in`) proves the session stuck.
  await page.waitForURL(/\/new$/);
  await expect(
    page.getByRole("heading", { name: "Create your store" }),
  ).toBeVisible();

  // 2) Create the store: a display name and the unique subdomain.
  await page.getByLabel("Store name").fill(storeName);
  await page.getByLabel("Subdomain").fill(slug);
  await page.getByRole("button", { name: "Create store" }).click();

  // 3) The new owner lands in their store's path-scoped admin. The store-scoped
  // layout's membership gate must pass for any of its chrome to render, so a
  // visible "Sign out" is proof the OWNER membership authorized this store; the
  // dashboard's "An overview of <name>" proves it's *this* newly created store.
  await page.waitForURL(`/admin/${slug}`);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByText(`An overview of ${storeName}.`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  // 4) The authoritative outcome, read straight from Postgres: the tenant exists
  // under the chosen slug with the given name, and the signer holds an OWNER
  // membership on it — the committed result of `createStore`'s tenant +
  // owner-membership write, end to end.
  const tenant = await readTenantBySlug(slug);
  expect(tenant.name).toBe(storeName);

  const user = await readUserByEmail(email);
  const membership = await readMembership(tenant.id, user.id);
  expect(membership.role).toBe("OWNER");
});
