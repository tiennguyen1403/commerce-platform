import { prisma } from "@/server/db";

/**
 * Data-access for products. Every method is scoped by `tenantId` so a store
 * can only ever touch its own catalog. Services call repositories; routes and
 * pages call services — never Prisma directly.
 */
export const productRepository = {
  listActiveByTenant(tenantId: string) {
    return prisma.product.findMany({
      where: { tenantId, status: "ACTIVE" },
      include: { variants: true },
      orderBy: { createdAt: "desc" },
    });
  },

  findBySlug(tenantId: string, slug: string) {
    return prisma.product.findUnique({
      where: { tenantId_slug: { tenantId, slug } },
      include: { variants: true },
    });
  },

  create(input: {
    tenantId: string;
    title: string;
    slug: string;
    description?: string;
  }) {
    return prisma.product.create({ data: input });
  },
};
