import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import type { ProductInput } from "@/lib/validators/catalog";
import { DuplicateSkuError, SlugTakenError } from "@/server/catalog.errors";

/**
 * Data-access for products. Every method is scoped by `tenantId` so a store
 * can only ever touch its own catalog. Services call repositories; routes and
 * pages call services — never Prisma directly. Prisma unique-constraint
 * failures are the repository's to translate, so the Prisma import stays here.
 */

/** Translate a Prisma unique-constraint failure into a typed catalog error;
 *  rethrow anything else untouched. Always throws (never returns). */
function mapWriteError(err: unknown): never {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002"
  ) {
    const target = String(
      (err.meta as { target?: unknown } | undefined)?.target ?? "",
    );
    if (target.includes("slug")) throw new SlugTakenError();
    if (target.includes("sku")) throw new DuplicateSkuError();
  }
  throw err;
}

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

  /**
   * Read variants by id, scoped to the tenant through the product relation
   * (`ProductVariant` has no `tenantId` of its own). Powers the cart/checkout
   * re-pricing: a foreign or unknown id simply doesn't come back. Includes the
   * minimal parent-product fields the caller needs to price the line and to drop
   * a variant whose product is no longer purchasable.
   */
  findVariantsForTenant(tenantId: string, ids: string[]) {
    return prisma.productVariant.findMany({
      where: { id: { in: ids }, product: { tenantId } },
      include: {
        product: {
          select: { id: true, title: true, slug: true, status: true },
        },
      },
    });
  },

  /** Create a product and its variants in one atomic write. */
  async createWithVariants(tenantId: string, input: ProductInput) {
    try {
      return await prisma.product.create({
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
    } catch (err) {
      mapWriteError(err);
    }
  },

  /**
   * Update a product and reconcile its variants (create added / update kept /
   * delete removed) in a single transaction. Returns null if the product isn't
   * owned by the tenant. The ownership gate runs first and every subsequent
   * write is scoped to the verified product id, so nothing can escape the
   * tenant boundary — even a tampered variant id resolves to zero rows.
   */
  async updateWithVariants(tenantId: string, id: string, input: ProductInput) {
    const kept = input.variants.filter(
      (v): v is ProductInput["variants"][number] & { id: string } =>
        Boolean(v.id),
    );
    const keptIds = kept.map((v) => v.id);

    try {
      return await prisma.$transaction(async (tx) => {
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

        // Delete variants the admin removed. An empty `keptIds` means every
        // existing variant was replaced, so the filter drops them all.
        // NOTE: this is a hard delete; `OrderItem.variant` is onDelete:Restrict,
        // so once checkout exists a variant with orders can't be removed this
        // way (tracked as a follow-up — variants aren't order-referenced yet).
        await tx.productVariant.deleteMany({
          where: {
            productId: id,
            ...(keptIds.length ? { id: { notIn: keptIds } } : {}),
          },
        });

        // Two-phase update of kept variants: park every SKU to a transient,
        // collision-proof value first, so an admin swapping or rotating SKUs
        // between existing variants can't trip @@unique([productId, sku])
        // mid-update. zod already proved the final set is unique.
        for (const v of kept) {
          await tx.productVariant.updateMany({
            where: { id: v.id, productId: id },
            data: { sku: `__tmp_${v.id}` },
          });
        }
        for (const v of kept) {
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
    } catch (err) {
      mapWriteError(err);
    }
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
