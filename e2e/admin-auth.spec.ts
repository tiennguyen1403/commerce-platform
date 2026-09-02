import { test, expect } from "@playwright/test";

import { SEEDED_ADMIN, SEEDED_NON_MEMBER } from "./support/seeded-admin";

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

  test("signs the seeded admin into their store admin, and sign-out re-gates it", async ({
    page,
  }) => {
    // The proxy bounces the anonymous visit to the sign-in form.
    await page.goto("/admin");
    await expect(page).toHaveURL(GATED_TO_SIGN_IN);

    // Sign in with the seeded admin credentials.
    await page.getByLabel("Email").fill(SEEDED_ADMIN.email);
    await page.getByLabel("Password").fill(SEEDED_ADMIN.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    // The form pushes to the validated redirect target (`/admin`), whose index
    // resolves the signed-in admin's one store and forwards into the path-scoped
    // admin `/admin/<slug>`; the store-scoped layout then renders — the "Sign
    // out" control only exists once the per-store gate has let us in.
    await expect(page).toHaveURL(`/admin/${SEEDED_ADMIN.storeSlug}`);
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

    // Signing out clears the session cookie and returns to the sign-in form...
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL("/sign-in");

    // ...so the gate is back in force: /admin bounces to sign-in once more.
    await page.goto("/admin");
    await expect(page).toHaveURL(GATED_TO_SIGN_IN);
  });

  test("refuses a signed-in non-member at a store they don't belong to", async ({
    page,
  }) => {
    const storeAdmin = `/admin/${SEEDED_ADMIN.storeSlug}`;

    // The deep store-admin link is gated for the anonymous visitor, preserving
    // the target through sign-in.
    await page.goto(storeAdmin);
    await expect(page).toHaveURL(
      new RegExp(`/sign-in\\?redirect=%2Fadmin%2F${SEEDED_ADMIN.storeSlug}$`),
    );

    // Sign in as an account that is NOT a member of this store.
    await page.getByLabel("Email").fill(SEEDED_NON_MEMBER.email);
    await page.getByLabel("Password").fill(SEEDED_NON_MEMBER.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    // The form forwards to the store admin, but the tenant-aware gate refuses a
    // non-member with a 404 (indistinguishable from an unknown store, so store
    // existence never leaks). It renders in place — the URL stays on the store
    // path, no redirect away — yet none of the admin chrome or dashboard shows.
    await expect(page).toHaveURL(storeAdmin);
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toHaveCount(
      0,
    );
  });
});
