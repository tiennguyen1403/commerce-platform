import { prisma } from "../src/server/db";
import { auth } from "../src/server/auth";
import { DEMO_TENANT_SLUG } from "../src/config/constants";

// Dev-only defaults; override via .env for a different seeded admin login.
const ADMIN_NAME = process.env.SEED_ADMIN_NAME ?? "Demo Admin";
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@demo.test";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "changeit-dev-only";

async function seedAdmin(tenantId: string) {
  // Better Auth stores the password hash on `Account` (providerId
  // "credential"), never on `User`, so the login must be created through the
  // sign-up API — a plain prisma.user.create() would be unable to sign in.
  const existing = await prisma.user.findUnique({
    where: { email: ADMIN_EMAIL },
    include: { accounts: true },
  });

  // A user with no credential account (e.g. a half-finished earlier seed) can't
  // sign in — drop it so sign-up can recreate the login cleanly.
  if (existing && existing.accounts.length === 0) {
    await prisma.user.delete({ where: { id: existing.id } });
  }

  let admin = existing?.accounts.length ? existing : null;
  if (!admin) {
    const { user } = await auth.api.signUpEmail({
      body: { name: ADMIN_NAME, email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    admin = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: { accounts: true },
    });
  }

  await prisma.membership.upsert({
    where: { userId_tenantId: { userId: admin.id, tenantId } },
    update: { role: "OWNER" },
    create: { userId: admin.id, tenantId, role: "OWNER" },
  });

  return admin;
}

type SeedVariant = {
  sku: string;
  name: string;
  priceCents: number;
  stock: number;
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
      { sku: "TEE-S", name: "Small", priceCents: 1999, stock: 100 },
      { sku: "TEE-M", name: "Medium", priceCents: 1999, stock: 100 },
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

async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: DEMO_TENANT_SLUG },
    update: {},
    create: { slug: DEMO_TENANT_SLUG, name: "Demo Store", currency: "usd" },
  });

  for (const product of PRODUCTS) {
    await prisma.product.upsert({
      where: { tenantId_slug: { tenantId: tenant.id, slug: product.slug } },
      update: {},
      create: {
        tenantId: tenant.id,
        title: product.title,
        slug: product.slug,
        description: product.description,
        status: product.status,
        variants: {
          create: product.variants.map((v) => ({
            sku: v.sku,
            name: v.name,
            priceCents: v.priceCents,
            stock: v.stock,
          })),
        },
      },
    });
  }

  const admin = await seedAdmin(tenant.id);

  console.log(
    `Seeded tenant "${tenant.slug}" with ${PRODUCTS.length} products and ` +
      `admin "${admin.email}" (OWNER).`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
