// Run via `pnpm db:seed`, which (see package.json → prisma.seed) invokes this with
// `node --conditions=react-server --import tsx`. That condition is required: this
// script pulls `src/server/**`, whose modules `import "server-only"`, and that
// package throws unless the runtime resolves its `react-server` export condition —
// plain `tsx`/Node doesn't set it. It's the seed's counterpart to the Vitest
// harness's `server-only` alias shim.
import { prisma } from "../src/server/db";
import { auth } from "../src/server/auth";
import { DEMO_TENANT_SLUG } from "../src/config/constants";

// Dev-only defaults; override via .env for a different seeded admin login.
const ADMIN_NAME = process.env.SEED_ADMIN_NAME ?? "Demo Admin";
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@demo.test";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "changeit-dev-only";

/**
 * Ensure a login exists for `email`, returning the user. Better Auth stores the
 * password hash on `Account` (providerId "credential"), never on `User`, so the
 * login must be created through the sign-up API — a plain prisma.user.create()
 * would be unable to sign in. Safe here (a bare Node script); calling
 * `signUpEmail` from an admin *request* would hijack the caller's session cookie
 * via `nextCookies()`, which is exactly why the members page adds existing users
 * only. Idempotent: re-seeding reuses an existing credential user.
 */
async function ensureUser(name: string, email: string, password: string) {
  const existing = await prisma.user.findUnique({
    where: { email },
    include: { accounts: true },
  });

  // A user with no credential account (e.g. a half-finished earlier seed) can't
  // sign in — drop it so sign-up can recreate the login cleanly.
  if (existing && existing.accounts.length === 0) {
    await prisma.user.delete({ where: { id: existing.id } });
  }

  if (existing?.accounts.length) return existing;

  const { user } = await auth.api.signUpEmail({
    body: { name, email, password },
  });
  return prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    include: { accounts: true },
  });
}

async function seedMembers(tenantId: string) {
  // The store owner.
  const owner = await ensureUser(ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD);
  await prisma.membership.upsert({
    where: { userId_tenantId: { userId: owner.id, tenantId } },
    update: { role: "OWNER" },
    create: { userId: owner.id, tenantId, role: "OWNER" },
  });

  // Extra dev accounts so the members admin page is exercisable end to end:
  // a STAFF member (list / change-role / remove), and one account with **no**
  // membership so "add an existing user by email" has a real target (and a
  // made-up email demonstrates the "ask them to sign up first" path).
  const staff = await ensureUser(
    "Demo Staff",
    "staff@demo.test",
    ADMIN_PASSWORD,
  );
  await prisma.membership.upsert({
    where: { userId_tenantId: { userId: staff.id, tenantId } },
    update: { role: "STAFF" },
    create: { userId: staff.id, tenantId, role: "STAFF" },
  });

  await ensureUser("Demo Teammate", "teammate@demo.test", ADMIN_PASSWORD);

  return owner;
}

type SeedVariant = {
  sku: string;
  name: string;
  priceCents: number;
  stock: number;
  // Optional mapping to the fulfillment provider's catalog variant id (M4).
  // Illustrative Printful-style integers on a couple of variants so the mock/
  // real submission flow has mapped data; the rest stay unmapped (null) to
  // exercise the "unmapped variant" path end to end.
  providerVariantId?: string;
};

type SeedProduct = {
  slug: string;
  title: string;
  description: string;
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  variants: SeedVariant[];
};

// A spread that exercises every storefront state: a plain multi-variant
// product, a variant selector with a low-stock and a per-variant sold-out
// option, a single-variant product, a fully sold-out product, and a DRAFT that
// must stay hidden from the public store (ACTIVE-only listing).
const PRODUCTS: SeedProduct[] = [
  {
    slug: "classic-tee",
    title: "Classic Tee",
    description: "A comfortable everyday t-shirt.",
    status: "ACTIVE",
    variants: [
      {
        sku: "TEE-S",
        name: "Small",
        priceCents: 1999,
        stock: 100,
        providerVariantId: "4011",
      },
      {
        sku: "TEE-M",
        name: "Medium",
        priceCents: 1999,
        stock: 100,
        providerVariantId: "4012",
      },
      // TEE-L is deliberately left unmapped (providerVariantId null) so the demo
      // catalog covers both the mapped and unmapped states in one product.
      { sku: "TEE-L", name: "Large", priceCents: 2199, stock: 50 },
    ],
  },
  {
    slug: "everyday-hoodie",
    title: "Everyday Hoodie",
    description: "Mid-weight fleece hoodie with a relaxed fit.",
    status: "ACTIVE",
    variants: [
      { sku: "HOOD-S", name: "Small", priceCents: 4900, stock: 12 },
      { sku: "HOOD-M", name: "Medium", priceCents: 4900, stock: 3 },
      { sku: "HOOD-L", name: "Large", priceCents: 5200, stock: 0 },
    ],
  },
  {
    slug: "canvas-tote-bag",
    title: "Canvas Tote Bag",
    description: "Heavy-duty cotton tote for the daily haul.",
    status: "ACTIVE",
    variants: [
      { sku: "TOTE-OS", name: "One size", priceCents: 2500, stock: 40 },
    ],
  },
  {
    slug: "enamel-mug",
    title: "Enamel Mug",
    description: "Camp-style enamel mug. Currently sold out.",
    status: "ACTIVE",
    variants: [{ sku: "MUG-12", name: "12 oz", priceCents: 1500, stock: 0 }],
  },
  {
    slug: "summer-cap",
    title: "Summer Cap",
    description: "Unreleased draft — should never appear on the storefront.",
    status: "DRAFT",
    variants: [
      { sku: "CAP-OS", name: "One size", priceCents: 2200, stock: 25 },
    ],
  },
];

type SeedImage = {
  // Filename committed under public/seed/; served statically at `/seed/<file>`.
  file: string;
  altText: string;
  // Intrinsic pixel dimensions — MUST match the committed file. Load-bearing for
  // next/image's remote-src contract once M5-05 renders these.
  width: number;
  height: number;
};

// Demo images for a few `demo`-store products, keyed by product slug.
// Deliberately partial: `classic-tee` gets two shots (so the PDP gallery /
// thumbnail rail has something to render once M5-05 lands), `everyday-hoodie`
// one, and every other product none — so the storefront's image-less placeholder
// fallback stays exercised too. Provider-independent: `url` = `/seed/<file>`
// (served from public/), `key` = `seed/<file>` (an opaque, non-Blob storage key).
// Only `demo` is seeded with images; `aurora` stays image-less.
const PRODUCT_IMAGES: Record<string, SeedImage[]> = {
  "classic-tee": [
    {
      file: "classic-tee-front.png",
      altText: "Classic Tee — front",
      width: 1200,
      height: 1200,
    },
    {
      file: "classic-tee-back.png",
      altText: "Classic Tee — back",
      width: 1200,
      height: 1200,
    },
  ],
  "everyday-hoodie": [
    {
      file: "everyday-hoodie.png",
      altText: "Everyday Hoodie",
      width: 1000,
      height: 1250,
    },
  ],
};

// A distinct accent hue for the second store so per-tenant theming (#98) is
// visible side by side: violet, well clear of the platform emerald (162°).
const AURORA_HUE = 285;

// The second store's small catalog — enough to show the themed accent across the
// grid, a purchase panel, a low-stock badge (the 14 oz mug sits below the
// threshold), and a multi-variant **selector** (Borealis Tee) whose dropdown
// portals to <body>: it's the one storefront accent surface aurora lacked, so it
// makes the portaled-overlay accent fix visible on a non-default hue (#113).
// Slugs are unique per tenant, so they may overlap with `demo`'s.
const AURORA_PRODUCTS: SeedProduct[] = [
  {
    slug: "aurora-candle",
    title: "Aurora Candle",
    description: "Hand-poured soy candle with a midnight-plum scent.",
    status: "ACTIVE",
    variants: [
      { sku: "AUR-CNDL", name: "One size", priceCents: 2400, stock: 60 },
    ],
  },
  {
    slug: "midnight-mug",
    title: "Midnight Mug",
    description: "Matte-violet stoneware mug that keeps coffee hot longer.",
    status: "ACTIVE",
    variants: [
      { sku: "AUR-MUG-14", name: "14 oz", priceCents: 1800, stock: 4 },
    ],
  },
  {
    slug: "borealis-tee",
    title: "Borealis Tee",
    description: "Organic-cotton tee in the Aurora colorway.",
    status: "ACTIVE",
    variants: [
      { sku: "AUR-TEE-S", name: "Small", priceCents: 2600, stock: 30 },
      { sku: "AUR-TEE-M", name: "Medium", priceCents: 2600, stock: 5 },
      { sku: "AUR-TEE-L", name: "Large", priceCents: 2800, stock: 0 },
    ],
  },
];

/** Upsert a tenant's catalog (idempotent by `[tenantId, slug]`). */
async function seedProducts(tenantId: string, products: SeedProduct[]) {
  for (const product of products) {
    await prisma.product.upsert({
      where: { tenantId_slug: { tenantId, slug: product.slug } },
      update: {},
      create: {
        tenantId,
        title: product.title,
        slug: product.slug,
        description: product.description,
        status: product.status,
        variants: {
          create: product.variants.map((v) => ({
            sku: v.sku,
            name: v.name,
            providerVariantId: v.providerVariantId ?? null,
            priceCents: v.priceCents,
            stock: v.stock,
          })),
        },
      },
    });
  }
}

/**
 * Seed a tenant's demo product images (idempotent). Each row uses a stable,
 * derived id (`seed-img-<tenantSlug>-<productSlug>-<position>`) so re-seeding
 * upserts in place rather than piling up duplicates — `ProductImage` has no
 * natural unique key. Products absent from `imagesBySlug` are left untouched
 * (their storefront surfaces fall back to the placeholder).
 */
async function seedProductImages(
  tenantSlug: string,
  tenantId: string,
  imagesBySlug: Record<string, SeedImage[]>,
) {
  for (const [slug, images] of Object.entries(imagesBySlug)) {
    const product = await prisma.product.findUnique({
      where: { tenantId_slug: { tenantId, slug } },
      select: { id: true },
    });
    if (!product) continue; // catalog changed under us — skip, don't throw.

    for (const [position, image] of images.entries()) {
      const id = `seed-img-${tenantSlug}-${slug}-${position}`;
      const fields = {
        tenantId,
        productId: product.id,
        url: `/seed/${image.file}`,
        key: `seed/${image.file}`,
        altText: image.altText,
        position,
        width: image.width,
        height: image.height,
      };
      await prisma.productImage.upsert({
        where: { id },
        update: fields,
        create: { id, ...fields },
      });
    }
  }
}

async function main() {
  // Primary store, on the platform default hue (162° emerald) — themeHue is left
  // to the column default, so it stays a visual no-op (#98).
  const demo = await prisma.tenant.upsert({
    where: { slug: DEMO_TENANT_SLUG },
    update: {},
    create: { slug: DEMO_TENANT_SLUG, name: "Demo Store", currency: "usd" },
  });
  await seedProducts(demo.id, PRODUCTS);
  await seedProductImages(DEMO_TENANT_SLUG, demo.id, PRODUCT_IMAGES);
  const owner = await seedMembers(demo.id);

  // A second store on a distinct hue so per-tenant theming is visible at a glance:
  // `demo.localhost:3000` renders emerald, `aurora.localhost:3000` violet, from
  // the one shared token recipe. `update` re-applies the hue on re-seed.
  // Deliberately storefront-only (no members): the admin-auth e2e assumes the
  // seeded admin owns exactly one store, so `admin@demo.test` must NOT own aurora.
  const aurora = await prisma.tenant.upsert({
    where: { slug: "aurora" },
    update: { themeHue: AURORA_HUE },
    create: {
      slug: "aurora",
      name: "Aurora",
      currency: "usd",
      themeHue: AURORA_HUE,
    },
  });
  await seedProducts(aurora.id, AURORA_PRODUCTS);

  const demoImageCount = Object.values(PRODUCT_IMAGES).reduce(
    (n, imgs) => n + imgs.length,
    0,
  );
  console.log(
    `Seeded "${demo.slug}" (emerald, ${PRODUCTS.length} products, ${demoImageCount} ` +
      `images) and ` +
      `"${aurora.slug}" (violet hue ${AURORA_HUE}, ${AURORA_PRODUCTS.length} products, ` +
      `storefront-only); owner "${owner.email}" (OWNER of ${demo.slug}), a STAFF member ` +
      `(staff@demo.test), and an unassigned account (teammate@demo.test) to add via the ` +
      `members page.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
