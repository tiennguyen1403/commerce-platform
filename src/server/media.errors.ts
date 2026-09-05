/**
 * Typed product-media errors, thrown by the image service's business rules and
 * mapped to field-level messages at the Server Action boundary (M5-04). Kept in a
 * dependency-free module — like `catalog.errors.ts` / `storage.errors.ts` — so both
 * the service (business rules) and the calling boundary can import them without
 * pulling in server-only code or the validators. The limits themselves live in
 * `src/lib/validators/catalog.ts` (the single source of truth) and are passed in,
 * so these messages never drift from the constants they describe.
 *
 * Storage *configuration* failures are a separate concern (`storage.errors.ts`'s
 * `StorageNotConfiguredError`); these are the input/business-rule failures of an
 * upload request.
 */

/** A whole megabyte, for humanising a byte ceiling in a message. */
const BYTES_PER_MB = 1024 * 1024;

/**
 * The product already holds the maximum number of images (`MAX_IMAGES_PER_PRODUCT`),
 * so another can't be added. Enforced at sign time in `imageService.requestUpload`
 * against a live DB count, so an admin never signs an upload that can't be persisted.
 */
export class ImageLimitReachedError extends Error {
  constructor(max: number) {
    super(`A product can have at most ${max} image${max === 1 ? "" : "s"}.`);
    this.name = "ImageLimitReachedError";
  }
}

/**
 * The requested upload's content type isn't on the allowlist
 * (`ALLOWED_IMAGE_CONTENT_TYPES`). Enforced server-side in `requestUpload` as the
 * authoritative re-check behind the form's client-side pre-check.
 */
export class UnsupportedImageTypeError extends Error {
  constructor(contentType: string, allowed: readonly string[]) {
    super(
      `Unsupported image type "${contentType}". Allowed: ${allowed.join(", ")}.`,
    );
    this.name = "UnsupportedImageTypeError";
  }
}

/**
 * The requested upload's declared size exceeds the per-image ceiling
 * (`MAX_IMAGE_SIZE_BYTES`). A soft guard on the client-declared size at sign time;
 * the storage sink re-checks the actual bytes as defence in depth.
 */
export class ImageTooLargeError extends Error {
  constructor(maxBytes: number) {
    const maxMb = Math.round(maxBytes / BYTES_PER_MB);
    super(`Image is too large (max ${maxMb} MB).`);
    this.name = "ImageTooLargeError";
  }
}

/**
 * The `key` submitted with a persist request isn't inside the tenant's own object
 * namespace (`tenants/<tenantId>/…`). The client echoes back the key the sign step
 * minted, and that key is later handed to `provider.delete(key)` — and a store's
 * keys are visible in its public image URLs — so persisting a forged key that
 * points at another tenant's object would let a delete cross the tenant boundary
 * (golden rule 1). The seam guarantees tenant-namespaced keys (`storage/provider.ts`),
 * so anything else is a tampered payload, refused at the write edge. A well-behaved
 * admin client never triggers this.
 */
export class InvalidImageKeyError extends Error {
  constructor() {
    super("That image couldn't be saved.");
    this.name = "InvalidImageKeyError";
  }
}

/**
 * No image with that id exists for this tenant's product — it was deleted (perhaps
 * in another tab) between the admin loading the manager and acting on it. Thrown by
 * the alt-text update path, where a no-op on a vanished row would otherwise leave
 * the manager showing a caption the store no longer has. Distinct from
 * `ProductNotFoundError` so the boundary can word it about the image, not the
 * product. (Delete stays idempotent — an already-gone image is success there — so
 * it never raises this.)
 */
export class ImageNotFoundError extends Error {
  constructor() {
    super("That image no longer exists.");
    this.name = "ImageNotFoundError";
  }
}

/**
 * A reorder request didn't list exactly the product's current images (a missing,
 * extra, duplicated, or foreign id). Refusing it keeps the gallery's `position`
 * sequence contiguous and collision-free rather than letting a malformed payload
 * corrupt the order — a well-behaved admin client always sends the full set.
 */
export class ImageReorderMismatchError extends Error {
  constructor() {
    super("The reorder must list exactly the product's current images.");
    this.name = "ImageReorderMismatchError";
  }
}
