import { test, expect } from "@playwright/test";

/**
 * The platform's apex landing page (`src/app/page.tsx`) — a smoke test that the
 * page renders and its four entry points keep their targets (#215 restyled it
 * UI + copy only).
 *
 * On the suite's bare `localhost` host the proxy's loopback fallback resolves
 * the demo store and 302s `/` to `/products`, so the landing is reached the way
 * it is in production: on a host that is NOT a store — here the reserved `www.`
 * subdomain (`RESERVED_SUBDOMAINS`). Chromium resolves `*.localhost` to
 * loopback on its own, so no DNS or hosts-file setup is involved.
 */
const LANDING_URL = "http://www.localhost:3000/";

test("landing page renders with its four unchanged targets", async ({
  page,
}) => {
  await page.goto(LANDING_URL);

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Multi-tenant commerce platform",
    }),
  ).toBeVisible();

  // The CTAs are the page's `Button render={<Link/>}` pattern: Base UI marks a
  // non-native button element `role="button"`, so they are buttons with an href.
  // The primary action repeats (hero + closing band); every copy targets `/new`.
  const create = page.getByRole("button", { name: "Create your store" });
  await expect(create).toHaveCount(2);
  for (const cta of await create.all()) {
    await expect(cta).toHaveAttribute("href", "/new");
  }
  const shop = page.getByRole("button", { name: "Shop the store" });
  await expect(shop).toHaveCount(2);
  for (const cta of await shop.all()) {
    await expect(cta).toHaveAttribute("href", "/products");
  }
  await expect(page.getByRole("button", { name: "Admin" })).toHaveAttribute(
    "href",
    "/admin",
  );
  await expect(
    page.getByRole("button", { name: "Health check" }),
  ).toHaveAttribute("href", "/api/health");

  // The stale "Phase 0" badge is gone for good.
  await expect(page.getByText("Phase 0")).toHaveCount(0);
});
