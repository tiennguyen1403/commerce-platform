import path from "node:path";
import { test, expect } from "@playwright/test";

import { SEEDED_ADMIN } from "./support/seeded-admin";
import { deleteProductImagesBySlug, disconnectDb } from "./support/db";

/**
 * The product-image feature end to end (M5): an admin uploads an image and it
 * renders on the public storefront in place of the placeholder icon. This is the
 * milestone's proof that the whole seam agrees — the admin manager's presign +
 * direct-PUT + persist flow, the local-disk storage mock's sink, and `next/image`
 * on the card and PDP — against a real production build (`pnpm build` + `pnpm
 * start`), driven through a real browser.
 *
 * **Mock provider only.** No `BLOB_READ_WRITE_TOKEN` is set, so `getStorageProvider`
 * falls back to the local-disk `MockStorageProvider`; its upload sink writes the
 * PUT'd bytes under `public/uploads/**`, served static + `unoptimized`, so nothing
 * here needs a real bucket, a network, or `sharp`. That fallback is gated on a
 * non-production `NODE_ENV`, which `playwright.config.ts` sets on the served
 * process (see the `webServer.env` note there) — `next start` alone would default
 * to production and 404 the sink.
 *
 * The spec uploads to `enamel-mug`, a seeded demo product that ships with **no**
 * images (so its "before" state is the placeholder icon) and that no other spec
 * touches. Unlike the onboarding spec's throwaway tenant, it's a persistent seed
 * row, so `beforeAll`/`afterAll` clear its images to keep local reruns idempotent
 * (CI reseeds a fresh database every run, so it starts clean regardless).
 */

// The seeded demo product this spec uploads to — image-less in the seed, ACTIVE
// (sold out, which only overlays a badge, never hides it). Inlined, not imported,
// to keep `e2e/**` clear of src's `server-only` modules (see `seeded-admin.ts`) —
// keep in lockstep with `prisma/seed.ts`.
const PRODUCT = { slug: "enamel-mug", title: "Enamel Mug" } as const;

// A committed, valid PNG reused purely as upload bytes — its visual content is
// irrelevant (the assertions check rendering, not pixels), so there's no need to
// add a new binary to the repo. `process.cwd()` is the project root under
// `pnpm test:e2e`.
const FIXTURE = path.resolve(
  process.cwd(),
  "public",
  "seed",
  "classic-tee-front.png",
);

const storeAdmin = `/admin/${SEEDED_ADMIN.storeSlug}`;

test.beforeAll(async () => {
  await deleteProductImagesBySlug(PRODUCT.slug);
});

test.afterAll(async () => {
  await deleteProductImagesBySlug(PRODUCT.slug);
  await disconnectDb();
});

test.describe("product images", () => {
  test("admin upload renders on the storefront card and PDP", async ({
    page,
  }) => {
    await test.step("the storefront starts with the placeholder, no image", async () => {
      // Anonymous PDP visit: an image-less product renders the muted lucide
      // placeholder (aria-hidden), so there is no image with the product's
      // accessible name yet — the "before" the upload replaces.
      await page.goto(`/products/${PRODUCT.slug}`);
      await expect(
        page.getByRole("heading", { name: PRODUCT.title }),
      ).toBeVisible();
      await expect(page.getByRole("img", { name: PRODUCT.title })).toHaveCount(
        0,
      );
    });

    await test.step("sign in as the seeded admin and open the product", async () => {
      // Deep-link the gated edit list; the proxy bounces to sign-in, and signing
      // in as the store owner forwards back to the preserved target.
      await page.goto(`${storeAdmin}/products`);
      await page.getByLabel("Email").fill(SEEDED_ADMIN.email);
      await page.getByLabel("Password").fill(SEEDED_ADMIN.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page).toHaveURL(`${storeAdmin}/products`);

      // Open the product's edit page (the image manager only mounts in edit mode).
      await page
        .getByRole("row")
        .filter({ hasText: PRODUCT.title })
        .getByRole("link", { name: "Edit" })
        .click();
      await expect(page).toHaveURL(new RegExp(`${storeAdmin}/products/[^/]+$`));
      // The manager is present and the product has no images to start.
      await expect(
        page.getByText("No images yet. Add one to show it on the storefront."),
      ).toBeVisible();
    });

    await test.step("upload an image and see it in the admin form", async () => {
      // Drive the hidden file input directly (Playwright sets files via CDP, no
      // click needed). The manager then presigns, PUTs the bytes to the mock's
      // sink, and persists the row — the thumbnail appears when that resolves. Its
      // alt is "Product image 1" (no caption), and its src is the mock's
      // root-relative `/uploads/…`, proving the bytes round-tripped through disk.
      await page.locator('input[type="file"]').setInputFiles(FIXTURE);
      const thumb = page.getByRole("img", { name: "Product image 1" });
      await expect(thumb).toBeVisible();
      await expect(thumb).toHaveAttribute("src", /\/uploads\//);
    });

    await test.step("the storefront card renders the uploaded image", async () => {
      await page.goto("/products");
      // The image's accessible name falls back to the product title (no caption),
      // so it's the enamel-mug card's image specifically.
      const cardImage = page
        .getByRole("link", { name: PRODUCT.title })
        .getByRole("img", { name: PRODUCT.title });
      await expect(cardImage).toBeVisible();
      await expect(cardImage).toHaveAttribute("src", /\/uploads\//);
    });

    await test.step("the PDP renders the uploaded image in place of the placeholder", async () => {
      await page.goto(`/products/${PRODUCT.slug}`);
      const galleryImage = page.getByRole("img", { name: PRODUCT.title });
      await expect(galleryImage).toBeVisible();
      await expect(galleryImage).toHaveAttribute("src", /\/uploads\//);
    });
  });
});
