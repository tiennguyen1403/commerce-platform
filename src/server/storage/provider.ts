/**
 * Abstraction over the image-object store (Vercel Blob in production, a local-disk
 * mock in dev/test/CI). The rest of the app depends only on this interface — swap
 * Blob for Cloudflare R2, a real bucket, or the mock without touching the product
 * or admin upload code. The exact mirror of `src/server/fulfillment/provider.ts`.
 *
 * Pure types only: this file is dependency-free (no `server-only`, no `env`) so the
 * interface can be referenced from anywhere. The concrete adapters and the selector
 * that read secrets live in `index.ts`/`mock.ts` and are server-only.
 */

export interface GetUploadUrlInput {
  /**
   * Tenant that owns the product (golden rule 1). First-class here because it
   * namespaces the object key — `tenants/<tenantId>/products/<productId>/…` — so
   * every object's tenant is a fact of its key, not something re-derived later
   * (mirrors `ProductImage.tenantId`, `prisma/schema.prisma`).
   */
  tenantId: string;
  /** Product the image belongs to; the second key namespace segment. */
  productId: string;
  /**
   * The upload's MIME type (e.g. `image/png`). The caller validates it against the
   * `ALLOWED_IMAGE_CONTENT_TYPES` allowlist at sign time; an adapter uses it to
   * derive the object's stored extension so the public URL is served with the right
   * content type. Kept a plain string on the seam — the allowlist is a business
   * rule (`src/lib/validators/catalog.ts`), not a provider concern.
   */
  contentType: string;
  /**
   * The original client file name, used only to derive a human-ish suffix/extension
   * on the key — never trusted as a path. Adapters generate a unique key regardless
   * (a random component), so two uploads of `photo.jpg` never collide.
   */
  fileName: string;
}

export interface GetUploadUrlResult {
  /**
   * Where the browser sends the raw bytes with a bare `PUT` — a short-lived
   * presigned URL for the real provider, or the same-origin dev sink
   * (`/api/uploads/local/…`) for the mock. Bytes go straight to storage, never
   * through a Server Action (which caps bodies at ~1 MB).
   */
  uploadUrl: string;
  /**
   * The URL the app renders the finished image from — a CDN URL for the real
   * provider, or a root-relative `/uploads/…` path (served static) for the mock.
   * Root-relative paths bypass `next.config` `remotePatterns`, so the mock renders
   * with no config change.
   */
  publicUrl: string;
  /**
   * The provider-opaque object key/pathname — the object's identity in the store,
   * kept distinct from `publicUrl` so a delete targets the object directly and a
   * provider swap never has to re-parse public URLs (persisted as
   * `ProductImage.key`).
   */
  key: string;
}

/**
 * The image-object store abstraction. `getUploadUrl` mints a direct-upload target
 * for one image; `delete` removes one object by its key and is **best-effort** — an
 * already-gone object is success, and a delete failure must never throw a
 * user-facing catalog operation off course (the calling service log-and-continues).
 */
export interface StorageProvider {
  readonly name: string;
  getUploadUrl(input: GetUploadUrlInput): Promise<GetUploadUrlResult>;
  delete(key: string): Promise<void>;
}
