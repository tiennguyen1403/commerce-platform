import { prisma } from "@/server/db";
import type { ProductInput } from "@/lib/validators/catalog";

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

  /** Admin listing: every status (incl. DRAFT/ARCHIVED), newest edits first. */
  listAllByTenant(tenantId: string) {
    return prisma.product.findMany({
      where: { tenantId },
      include: { variants: { orderBy: { createdAt: "asc" } } },
      orderBy: { updatedAt: "desc" },
    });
  },

  findBySlug(tenantId: string, slug: string) {
    return prisma.product.findUnique({
      where: { tenantId_slug: { tenantId, slug } },
      include: { variants: true },
    });
  },

  /**
   * Single product for the admin editor. Uses `findFirst` so the tenant scope
   * is part of the WHERE — an id belonging to another tenant resolves to null
   * rather than leaking a row.
   */
  findByIdForTenant(tenantId: string, id: string) {
    return prisma.product.findFirst({
      where: { id, tenantId },
      include: { variants: { orderBy: { createdAt: "asc" } } },
    });
  },

  /** Create a product and its variants in one atomic write. */
  createWithVariants(tenantId: string, input: ProductInput) {
    return prisma.product.create({
      data: {
        tenantId,
        title: input.title,
        slug: input.slug,
        description: input.description ?? null,
        status: input.status,
        variants: {
          create: input.variants.map((v) => ({
            sku: v.sku,
            name: v.name,
            priceCents: v.priceCents,
            currency: v.currency,
            stock: v.stock,
          })),
        },
      },
      include: { variants: { orderBy: { createdAt: "asc" } } },
    });
  },

  /**
   * Update a product and reconcile its variants (create added / update kept /
   * delete removed) in a single transaction. Returns null if the product isn't
   * owned by the tenant. The ownership gate runs first and every subsequent
   * write is scoped to the verified product id, so nothing can escape the
   * tenant boundary — even a tampered variant id resolves to zero rows.
   */
  updateWithVariants(tenantId: string, id: string, input: ProductInput) {
    return prisma.$transaction(async (tx) => {
      const owned = await tx.product.findFirst({
        where: { id, tenantId },
        select: { id: true },
      });
      if (!owned) return null;

      await tx.product.update({
        where: { id },
        data: {
          title: input.title,
          slug: input.slug,
          description: input.description ?? null,
          status: input.status,
        },
      });

      const keptIds = input.variants.flatMap((v) => (v.id ? [v.id] : []));
      // Delete variants the admin removed. An empty `keptIds` means every
      // existing variant was replaced, so the filter drops them all for this
      // product.
      await tx.productVariant.deleteMany({
        where: {
          productId: id,
          ...(keptIds.length ? { id: { notIn: keptIds } } : {}),
        },
      });

      for (const v of input.variants) {
        if (!v.id) continue;
        // updateMany (not update) keeps the write scoped to this product: a
        // stale or foreign id matches zero rows instead of touching it.
        await tx.productVariant.updateMany({
          where: { id: v.id, productId: id },
          data: {
            sku: v.sku,
            name: v.name,
            priceCents: v.priceCents,
            currency: v.currency,
            stock: v.stock,
          },
        });
      }

      const added = input.variants.filter((v) => !v.id);
      if (added.length) {
        await tx.productVariant.createMany({
          data: added.map((v) => ({
            productId: id,
            sku: v.sku,
            name: v.name,
            priceCents: v.priceCents,
            currency: v.currency,
            stock: v.stock,
          })),
        });
      }

      return tx.product.findUnique({
        where: { id },
        include: { variants: { orderBy: { createdAt: "asc" } } },
      });
    });
  },

  /** Soft-remove: flip status to ARCHIVED. Returns the number of rows changed
   * (0 = not found / not this tenant's). */
  async archive(tenantId: string, id: string) {
    const { count } = await prisma.product.updateMany({
      where: { id, tenantId },
      data: { status: "ARCHIVED" },
    });
    return count;
  },
};
