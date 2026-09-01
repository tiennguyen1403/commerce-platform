/**
 * The admin login created by `prisma/seed.ts` (`seedMembers` provisions it as the
 * store OWNER). The auth-gate spec signs in as this account, so these defaults
 * must stay in lockstep with the seed script — both read the same `SEED_ADMIN_*`
 * env vars with the same fallbacks, so overriding one for a run overrides both.
 */
export const SEEDED_ADMIN = {
  email: process.env.SEED_ADMIN_EMAIL ?? "admin@demo.test",
  password: process.env.SEED_ADMIN_PASSWORD ?? "changeit-dev-only",
} as const;
