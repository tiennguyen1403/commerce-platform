import { prisma } from "../src/server/db";

async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: "demo" },
    update: {},
    create: { slug: "demo", name: "Demo Store" },
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

  console.log(
    `Seeded tenant "${tenant.slug}" with product "${product.title}".`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
