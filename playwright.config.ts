import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E — runs against a production build (`next build` + `next start`),
 * never `next dev`. Turbopack's dev server is the flaky one, and Playwright's own
 * CI guide recommends exercising the built app. The `webServer` below boots
 * `pnpm start` and waits for it, so the local loop is: `pnpm build` once, then
 * `pnpm test:e2e`.
 *
 * Local prerequisites: a seeded Postgres (`docker compose up -d`, `pnpm db:deploy`,
 * `pnpm db:seed`) and a complete env — the auth-gate spec signs in as the seeded
 * admin (see `e2e/support/seeded-admin.ts`). The dedicated `e2e` CI job that wires
 * these up in GitHub Actions is issue #50.
 */

// `localhost` (not `127.0.0.1`) matches BETTER_AUTH_URL, so Better Auth treats
// the browser's requests as same-origin and the session cookie sticks.
const BASE_URL = "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  // A stray `test.only` fails the CI run instead of silently skipping the rest.
  forbidOnly: !!process.env.CI,
  // The suite is deterministic; a couple of retries only absorb rare CI flakes.
  retries: process.env.CI ? 2 : 0,
  // One worker: the specs sign in and out of a single shared session against a
  // single production server — parallel workers would race on the auth cookie.
  workers: 1,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
  use: {
    baseURL: BASE_URL,
    // Keep a trace only when a test is retried, so failures are diagnosable
    // without paying the cost on every green run.
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm start",
    url: BASE_URL,
    // Reuse a server you already have up locally; always boot a fresh one in CI.
    // Caveat: this reuses whatever already holds :3000 — stop any stray
    // `pnpm dev` first, or the suite silently runs against the flaky Turbopack
    // dev server this harness is meant to avoid.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Run the served app in NODE_ENV=test so the product-image E2E can reach the
    // local-disk storage mock. Like the fulfillment mock, storage's mock is gated
    // OFF in production: `getStorageProvider()` returns null and the upload sink
    // `PUT /api/uploads/local/[...key]` 404s when `env.NODE_ENV === "production"`
    // (src/server/storage/index.ts, src/app/api/uploads/local/[...key]/route.ts).
    // `next start` defaults NODE_ENV to "production", so without this override the
    // upload step would deterministically fail. `src/lib/env.ts` reads NODE_ENV
    // *live* at runtime (it parses the whole `process.env`, not the discrete
    // `process.env.NODE_ENV` literal that `next build` freezes), so flipping it
    // here — for this spawned server only, never the prior `pnpm build` — swaps
    // the storage (and fulfillment) selectors to their mocks while the production
    // client bundle is untouched. Playwright merges this over the inherited
    // `process.env`, so DATABASE_URL / auth / Stripe vars are all preserved. This
    // reaches only a server Playwright *spawns*: a server you already have on
    // :3000 (reused per `reuseExistingServer` above) must itself have been started
    // with NODE_ENV=test, or the image upload hits the production-gated null
    // provider and a 404 sink. CI always spawns fresh, so it's unaffected.
    env: { NODE_ENV: "test" },
  },
});
