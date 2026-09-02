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
  },
});
