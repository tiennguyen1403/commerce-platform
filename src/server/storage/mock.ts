import "server-only";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import {
  type AllowedImageContentType,
  IMAGE_CONTENT_TYPE_EXTENSIONS,
} from "@/lib/validators/catalog";
import type {
  GetUploadUrlInput,
  GetUploadUrlResult,
  StorageProvider,
} from "./provider";
import {
  LOCAL_PUBLIC_URL_PREFIX,
  LOCAL_UPLOAD_SINK_PREFIX,
  resolveLocalUploadPath,
} from "./local-path";

/**
 * Stored file extension for a content type, so the object is served static by Next
 * with a name whose extension matches its bytes (a `.png`/`.jpg`/`.webp` is served
 * with the right `Content-Type`). Uses the shared allowlist→extension map; anything
 * off the upload allowlist (`ALLOWED_IMAGE_CONTENT_TYPES`, enforced upstream at sign
 * time) can only reach here via a direct/test call, so it falls back to a neutral
 * `bin` rather than trusting the caller's file name for an extension.
 */
function extensionForContentType(contentType: string): string {
  return (
    IMAGE_CONTENT_TYPE_EXTENSIONS[contentType as AllowedImageContentType] ??
    "bin"
  );
}

/**
 * Reduce the original file name to a short, path-safe slug used only as a
 * human-readable middle of the key (never as a path itself) — the object's
 * identity is the random component. Strips the extension, lowercases, collapses
 * every non-alphanumeric run to a single hyphen, and caps the length; an empty
 * result falls back to `image`.
 */
function safeFileNameSlug(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^.]*$/, "");
  const slug = withoutExtension
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "image";
}

/**
 * A deterministic, local-disk `StorageProvider` — the CI/test default and dev
 * fallback (no `BLOB_READ_WRITE_TOKEN` needed), and the reason everything above the
 * storage boundary is buildable before the real Vercel Blob adapter exists (M5-06).
 * Holds no real credentials and reaches no network.
 *
 * The wrinkle over the fulfillment mock (which returns canned strings): an image
 * mock must expose **real bytes** for the browser and `next/image` to fetch. So
 * `getUploadUrl` points `uploadUrl` at a same-origin dev/test sink
 * (`PUT /api/uploads/local/[...key]`) that writes the `PUT`ed bytes under
 * `public/uploads/**`, and `publicUrl` at the root-relative `/uploads/…` path Next
 * then serves static. Both are derived from the same namespaced `key`
 * (`tenants/<tenantId>/products/<productId>/<random>-<slug>.<ext>`), so the sink,
 * the delete, and the public URL all agree on one object identity. `delete` unlinks
 * that file, best-effort. Unlike the fulfillment mock it is stateless — the disk is
 * the state — so it needs no shared singleton for correctness (the selector still
 * memoizes one, matching the fulfillment shape).
 */
export class MockStorageProvider implements StorageProvider {
  readonly name = "mock";

  async getUploadUrl(input: GetUploadUrlInput): Promise<GetUploadUrlResult> {
    const extension = extensionForContentType(input.contentType);
    const slug = safeFileNameSlug(input.fileName);
    // Random component first, so the key is unique even for repeat uploads of the
    // same file name — the store never clobbers, matching the real provider's
    // random-suffix behaviour. tenantId/productId are DB cuids, so the key is
    // separator-free by construction; the sink/delete still re-validate it.
    const key = `tenants/${input.tenantId}/products/${input.productId}/${randomUUID()}-${slug}.${extension}`;
    return {
      uploadUrl: `${LOCAL_UPLOAD_SINK_PREFIX}/${key}`,
      publicUrl: `${LOCAL_PUBLIC_URL_PREFIX}/${key}`,
      key,
    };
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(resolveLocalUploadPath(key));
    } catch {
      // Best-effort (the interface's contract): an already-removed object
      // (ENOENT), an unsafe key, or any unlink failure is swallowed — deleting an
      // image must never throw a catalog operation off course, and the desired
      // end-state (object gone) is reached either way. Dev/test-only bytes.
    }
  }
}
