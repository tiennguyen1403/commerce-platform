import "server-only";
import {
  imageRepository,
  type CreateImageInput,
} from "@/server/repositories/image.repository";
import { getStorageProvider, type GetUploadUrlResult } from "@/server/storage";
import {
  ALLOWED_IMAGE_CONTENT_TYPES,
  MAX_IMAGE_SIZE_BYTES,
  MAX_IMAGES_PER_PRODUCT,
} from "@/lib/validators/catalog";
import { ProductNotFoundError } from "@/server/catalog.errors";
import { StorageNotConfiguredError } from "@/server/storage.errors";
import {
  ImageLimitReachedError,
  ImageReorderMismatchError,
  ImageTooLargeError,
  UnsupportedImageTypeError,
} from "@/server/media.errors";
import { logger } from "@/server/observability/logger";

/**
 * Business logic for product images: the sign→upload→persist flow plus reorder and
 * delete. This layer owns the upload rules (content-type allowlist, size cap, and
 * the per-product count cap that only a DB read can decide) and delegates the object
 * store to the `StorageProvider` seam — never touching Prisma (that's the repository)
 * or the store SDK directly (that's the provider). Shape validation (zod) happens at
 * the Server Action boundary (M5-04); the checks here are the authoritative,
 * bypass-proof re-checks, mirroring how the catalog service owns its business rules.
 *
 * The bytes never pass through this layer: `requestUpload` mints a direct-upload URL
 * the browser PUTs to, then the client calls `addImage` with the resulting
 * `url`/`key` (+ client-measured dims). See `docs/milestones/M5-product-images`.
 */

// Re-export every error a caller (the Server Action) may need, from one place — so
// the boundary maps them to field messages without reaching into three error modules.
export { ProductNotFoundError } from "@/server/catalog.errors";
export { StorageNotConfiguredError } from "@/server/storage.errors";
export {
  ImageLimitReachedError,
  ImageReorderMismatchError,
  ImageTooLargeError,
  UnsupportedImageTypeError,
} from "@/server/media.errors";

const log = logger.child({ component: "product-images" });

/** Input to `requestUpload`: the client-declared facts about the file it wants to
 *  PUT. `sizeBytes` is the declared size (the actual bytes are re-checked at the
 *  storage sink); `fileName` only seeds a human-ish key suffix. */
export type RequestUploadInput = {
  contentType: string;
  fileName: string;
  sizeBytes: number;
};

/** Input to `addImage`: what the client learned from the direct upload (`url`/`key`
 *  from the presign) plus optional alt text and client-measured intrinsic dims. */
export type AddImageInput = CreateImageInput;

export const imageService = {
  /**
   * Validate an upload request and mint a direct-upload target for it. Enforces, in
   * order: the content-type allowlist and the size cap (cheap, user-fixable input
   * rules); that storage is configured at all (an operator concern — fail fast
   * before any DB read, like the fulfillment service); and the per-product count cap
   * against a live DB count, which also proves the product is the tenant's. Only
   * then is a URL signed, so an admin never gets a URL for an upload that couldn't be
   * persisted.
   */
  async requestUpload(
    tenantId: string,
    productId: string,
    input: RequestUploadInput,
  ): Promise<GetUploadUrlResult> {
    if (
      !(ALLOWED_IMAGE_CONTENT_TYPES as readonly string[]).includes(
        input.contentType,
      )
    ) {
      throw new UnsupportedImageTypeError(
        input.contentType,
        ALLOWED_IMAGE_CONTENT_TYPES,
      );
    }
    if (input.sizeBytes > MAX_IMAGE_SIZE_BYTES) {
      throw new ImageTooLargeError(MAX_IMAGE_SIZE_BYTES);
    }

    // Fail fast if storage isn't configured — no point reading counts for an upload
    // we could never sign (prod with no BLOB_READ_WRITE_TOKEN → null selector).
    const provider = getStorageProvider();
    if (!provider) {
      throw new StorageNotConfiguredError();
    }

    // Count-cap against the DB — also the tenant-ownership gate: `null` means the
    // product isn't this tenant's, so we refuse rather than sign into its namespace.
    const count = await imageRepository.getImageCountForOwnedProduct(
      tenantId,
      productId,
    );
    if (count === null) {
      throw new ProductNotFoundError();
    }
    // Soft cap, enforced at sign time against a live count. Two uploads signed
    // concurrently can both observe a below-cap count and each persist a row, so
    // the product can momentarily exceed the cap — an accepted overage for a
    // UX/cost guard (`MAX_IMAGES_PER_PRODUCT`), not a hard invariant (the reorder/
    // create races are documented the same way in the repository).
    if (count >= MAX_IMAGES_PER_PRODUCT) {
      throw new ImageLimitReachedError(MAX_IMAGES_PER_PRODUCT);
    }

    return provider.getUploadUrl({
      tenantId,
      productId,
      contentType: input.contentType,
      fileName: input.fileName,
    });
  },

  /**
   * Persist an image row after the client's direct PUT succeeded. The repository
   * appends it (computing `position`) and re-verifies tenant ownership atomically;
   * `null` from it means the product isn't the tenant's (or was deleted between the
   * sign and now), surfaced as `ProductNotFoundError`.
   */
  async addImage(tenantId: string, productId: string, input: AddImageInput) {
    const image = await imageRepository.createImage(tenantId, productId, input);
    if (!image) {
      throw new ProductNotFoundError();
    }
    return image;
  },

  /**
   * Set the gallery order to `orderedIds`. Guards that the set is exactly the
   * product's current images (a permutation — same ids, no missing/extra/duplicate),
   * so a malformed payload can't leave `position` colliding or gapped; a well-behaved
   * admin client always sends the full set. Throws `ImageReorderMismatchError`
   * otherwise. The comparison is tenant-scoped (via `listImages`), so it can't be
   * satisfied with another store's ids.
   */
  async reorderImages(
    tenantId: string,
    productId: string,
    orderedIds: string[],
  ): Promise<void> {
    const current = await imageRepository.listImages(tenantId, productId);
    const currentIds = new Set(current.map((image) => image.id));
    const requestedIds = new Set(orderedIds);
    const isPermutation =
      orderedIds.length === current.length &&
      requestedIds.size === orderedIds.length &&
      [...requestedIds].every((id) => currentIds.has(id));
    if (!isPermutation) {
      throw new ImageReorderMismatchError();
    }

    await imageRepository.reorderImages(tenantId, productId, orderedIds);
  },

  /**
   * Delete one image: remove the row (authoritative), then best-effort delete the
   * stored object by its key. Returns the removed row, or `null` if nothing matched
   * (an already-deleted image is idempotent success — the desired end state holds —
   * so this never throws a not-found). A storage failure (or unconfigured storage)
   * is logged and swallowed: the row is already gone, so the image no longer renders;
   * a lingering object is a tolerated orphan, never a reason to fail the operation.
   */
  async deleteImage(tenantId: string, productId: string, imageId: string) {
    const image = await imageRepository.deleteImage(
      tenantId,
      productId,
      imageId,
    );
    if (!image) {
      return null;
    }

    const provider = getStorageProvider();
    if (provider) {
      try {
        await provider.delete(image.key);
      } catch (err) {
        log.warn(
          { err, tenantId, productId, imageId, key: image.key },
          "product-images: object delete failed — row removed, object may linger",
        );
      }
    } else {
      log.warn(
        { tenantId, productId, imageId, key: image.key },
        "product-images: storage not configured — row removed, object not deleted",
      );
    }

    return image;
  },
};
