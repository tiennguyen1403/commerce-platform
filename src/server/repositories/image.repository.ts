import "server-only";
import type { ProductImage } from "@prisma/client";
import { prisma } from "@/server/db";

/**
 * Data-access for product images. Like every repository, each method is scoped by
 * `tenantId` (golden rule 1) — the `where` always carries it, so a store can only
 * ever touch its own media. Services call this; routes and pages never do, and
 * Prisma lives only here.
 *
 * A `ProductImage` carries its own `tenantId` (a deliberate divergence from
 * `ProductVariant`, which is scoped only through its product — see
 * `prisma/schema.prisma`), which is what lets these reads/deletes filter on the
 * tenant directly. The write paths additionally verify the parent product belongs
 * to the tenant: an image's `tenantId` must equal its product's, or a caller could
 * attach an image to another tenant's product (the `product.images` relation
 * include is by `productId` alone, so a mismatched row would leak onto that
 * product's storefront). That check is done atomically in the same transaction as
 * the write, so it can't be raced.
 */

/**
 * Fields the service persists for one image. `url`/`key` come from the storage
 * provider's `getUploadUrl`; `altText`/`width`/`height` are optional (dims are
 * measured client-side, alt text is admin-entered). `position` is NOT here — the
 * create path always computes it as the next append slot, so callers can't create
 * a gap or a collision.
 */
export type CreateImageInput = {
  url: string;
  key: string;
  altText?: string | null;
  width?: number | null;
  height?: number | null;
};

export const imageRepository = {
  /** A product's images in gallery order (index-served by
   *  `@@index([productId, position])`). Tenant-scoped: a foreign product id yields
   *  an empty list, never another store's images. */
  listImages(tenantId: string, productId: string): Promise<ProductImage[]> {
    return prisma.productImage.findMany({
      where: { tenantId, productId },
      orderBy: { position: "asc" },
    });
  },

  /**
   * The current image count for a product the tenant owns, for the sign-time cap
   * check — or `null` when the product isn't the tenant's (so the caller refuses to
   * sign an upload for it rather than signing into this tenant's key namespace for a
   * product it doesn't own). Ownership and count are read in one transaction so the
   * count can't be attributed to a product the caller can't see.
   */
  getImageCountForOwnedProduct(
    tenantId: string,
    productId: string,
  ): Promise<number | null> {
    return prisma.$transaction(async (tx) => {
      const owned = await tx.product.findFirst({
        where: { id: productId, tenantId },
        select: { id: true },
      });
      if (!owned) return null;
      return tx.productImage.count({ where: { tenantId, productId } });
    });
  },

  /**
   * Persist one image, appended at the end of the gallery. Returns the created row,
   * or `null` if the product isn't the tenant's (the cross-tenant-attachment gate).
   * `position` is computed as the current count — a contiguous 0,1,2,… append — in
   * the same transaction as the ownership check and the insert, so the read that
   * computes it and the write that uses it can't be split. (Two truly-concurrent
   * appends could still pick the same slot under READ COMMITTED; that's a benign,
   * admin-fixable tie the gallery breaks by id and any reorder resolves — never a
   * correctness or tenancy issue, so it needs no heavier lock for this low-rate,
   * single-admin write.)
   */
  async createImage(
    tenantId: string,
    productId: string,
    input: CreateImageInput,
  ): Promise<ProductImage | null> {
    return prisma.$transaction(async (tx) => {
      const owned = await tx.product.findFirst({
        where: { id: productId, tenantId },
        select: { id: true },
      });
      if (!owned) return null;

      const position = await tx.productImage.count({
        where: { tenantId, productId },
      });

      return tx.productImage.create({
        data: {
          tenantId,
          productId,
          url: input.url,
          key: input.key,
          altText: input.altText ?? null,
          width: input.width ?? null,
          height: input.height ?? null,
          position,
        },
      });
    });
  },

  /**
   * Rewrite `position` for the given images to their index in `orderedIds` (0-based),
   * in one transaction. Every update is scoped to `{ tenantId, productId }`, so a
   * foreign or unknown id simply matches zero rows — nothing escapes the tenant/
   * product boundary. Returns the number of rows actually moved (the count of
   * provided ids that matched a row) — a sanity signal for callers/tests; the
   * service authoritatively validates the set up front via `listImages`. A
   * concurrent delete of a non-last image mid-reorder can leave a benign `position`
   * gap (e.g. 0, 2) which still renders in order and the next reorder rewrites
   * contiguous — the reorder analogue of `createImage`'s documented position race.
   */
  async reorderImages(
    tenantId: string,
    productId: string,
    orderedIds: string[],
  ): Promise<number> {
    const results = await prisma.$transaction(
      orderedIds.map((id, index) =>
        prisma.productImage.updateMany({
          where: { id, tenantId, productId },
          data: { position: index },
        }),
      ),
    );
    return results.reduce((sum, result) => sum + result.count, 0);
  },

  /**
   * Delete one image and return the removed row (so the service can best-effort
   * delete its object by `key`), or `null` if nothing matched. The lookup and the
   * delete are both scoped to `{ tenantId, productId }` and run in one transaction,
   * so a foreign id can neither be read nor removed. The removal uses `deleteMany`
   * (not `delete`) so a concurrent delete of the same row is idempotent success —
   * it matches zero rows rather than throwing `P2025` — matching the service's
   * "an already-deleted image is fine" intent.
   */
  async deleteImage(
    tenantId: string,
    productId: string,
    imageId: string,
  ): Promise<ProductImage | null> {
    return prisma.$transaction(async (tx) => {
      const image = await tx.productImage.findFirst({
        where: { id: imageId, tenantId, productId },
      });
      if (!image) return null;
      await tx.productImage.deleteMany({
        where: { id: image.id, tenantId, productId },
      });
      return image;
    });
  },
};
