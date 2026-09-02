import { test, expect } from "@playwright/test";

import { SEEDED_ADMIN } from "./support/seeded-admin";

/**
 * The admin auth gate, end to end. Two layers cooperate: `src/proxy.ts` does the
 * cheap cookie-only redirect (bouncing anonymous visitors to the sign-in form
 * with the original path in a `redirect` query param), and the admin layout runs
 * the authoritative session + membership check. This spec drives the whole gate
 * through a real browser against a production build.
 */

// The proxy encodes the gated path with `URLSearchParams`, so `/admin` arrives as
// `%2Fadmin`. Anchored at the end to tolerate the absolute base URL in front.
const GATED_TO_SIGN_IN = /\/sign-in\?redirect=%2Fadmin$/;

test.describe("admin auth gate", () => {
  test("redirects an unauthenticated visitor from /admin to sign-in", async ({
    page,
  }) => {
    await page.goto("/admin");

    await expect(page).toHaveURL(GATED_TO_SIGN_IN);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("signs the seeded admin in to /admin, and sign-out re-gates it", async ({
    page,
  }) => {
    // The proxy bounces the anonymous visit to the sign-in form.
    await page.goto("/admin");
    await expect(page).toHaveURL(GATED_TO_SIGN_IN);

    // Sign in with the seeded admin credentials.
    await page.getByLabel("Email").fill(SEEDED_ADMIN.email);
    await page.getByLabel("Password").fill(SEEDED_ADMIN.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    // The form pushes to the validated redirect target and the admin layout
    // renders — the "Sign out" control only exists once the gate has let us in.
    await expect(page).toHaveURL("/admin");
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

    // Signing out clears the session cookie and returns to the sign-in form...
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL("/sign-in");

    // ...so the gate is back in force: /admin bounces to sign-in once more.
    await page.goto("/admin");
    await expect(page).toHaveURL(GATED_TO_SIGN_IN);
  });
});
