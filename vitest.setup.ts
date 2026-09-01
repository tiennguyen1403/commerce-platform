// Dummy environment for Vitest, mirroring the block in `.github/workflows/ci.yml`.
//
// `@/lib/env` validates every required var with zod at *import* time and throws
// if any is missing, so a test that transitively imports it would crash before it
// runs. This runs via `setupFiles` (before any test module loads) and seeds
// placeholders. `??=` only fills a var that is unset, so a real value from the
// shell or a `.env` still wins — handy when a test needs a genuine connection.
//
// Keep in sync with `ci.yml`. None of these are secrets: the harness never opens
// a network/DB connection with them (the Stripe/Resend/Prisma clients are all
// lazy), so any non-empty placeholder satisfies the schema.
process.env.DATABASE_URL ??=
  "postgresql://postgres:postgres@localhost:5432/dropshipping";
process.env.BETTER_AUTH_SECRET ??= "ci-secret-ci-secret-ci-secret-1234";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
process.env.STRIPE_SECRET_KEY ??= "sk_test_ci_dummy";
process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_ci_dummy";
process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ??= "pk_test_ci_dummy";
process.env.RESEND_API_KEY ??= "re_ci_dummy";
process.env.EMAIL_FROM ??= "CI <onboarding@resend.dev>";
