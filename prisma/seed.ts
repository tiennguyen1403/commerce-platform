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

async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: DEMO_TENANT_SLUG },
    update: {},
    create: { slug: DEMO_TENANT_SLUG, name: "Demo Store" },
  });

  const product = await prisma.product.upsert({
    where: { tenantId_slug: { tenantId: tenant.id, slug: "classic-tee" } },
    update: {},
    create: {
      tenantId: tenant.id,
      title: "Classic Tee",
      slug: "classic-tee",
      description: "A comfortable everyday t-shirt.",
      status: "ACTIVE",
      variants: {
        create: [
          { sku: "TEE-S", name: "Small", priceCents: 1999, stock: 100 },
          { sku: "TEE-M", name: "Medium", priceCents: 1999, stock: 100 },
          { sku: "TEE-L", name: "Large", priceCents: 2199, stock: 50 },
        ],
      },
    },
  });

  const admin = await seedAdmin(tenant.id);

  console.log(
    `Seeded tenant "${tenant.slug}" with product "${product.title}" and ` +
      `admin "${admin.email}" (OWNER).`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
