/**
 * The admin login created by `prisma/seed.ts` (`seedMembers` provisions it as the
 * store OWNER). The auth-gate spec signs in as this account, so these defaults
 * must stay in lockstep with the seed script — both read the same `SEED_ADMIN_*`
 * env vars with the same fallbacks, so overriding one for a run overrides both.
 *
 * `storeSlug` is the seeded demo store this admin owns (`DEMO_TENANT_SLUG` in
 * `src/config/constants.ts`); the path-scoped admin lives at `/admin/<storeSlug>`,
 * so the spec asserts the post-sign-in landing there. Inlined (not imported) to
 * keep `e2e/**` clear of src's `server-only` modules — keep it in lockstep.
 */
export const SEEDED_ADMIN = {
  email: process.env.SEED_ADMIN_EMAIL ?? "admin@demo.test",
  password: process.env.SEED_ADMIN_PASSWORD ?? "changeit-dev-only",
  storeSlug: "demo",
} as const;

/**
 * A seeded account that belongs to NO store — `prisma/seed.ts` provisions
 * `teammate@demo.test` as an unassigned user (there for the members page to
 * add). The auth-gate spec signs in as this account to prove the tenant-aware
 * admin gate refuses a non-member at a store they don't belong to. The seed
 * gives every seeded login the same `SEED_ADMIN_PASSWORD`, so it shares that
 * fallback.
 */
export const SEEDED_NON_MEMBER = {
  email: "teammate@demo.test",
  password: process.env.SEED_ADMIN_PASSWORD ?? "changeit-dev-only",
} as const;
