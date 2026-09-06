import "server-only";
import { unlink } from "node:fs/promises";
import type {
  GetUploadUrlInput,
  GetUploadUrlResult,
  StorageProvider,
} from "./provider";
import { buildObjectKey } from "./object-key";
import {
  LOCAL_PUBLIC_URL_PREFIX,
  LOCAL_UPLOAD_SINK_PREFIX,
  resolveLocalUploadPath,
} from "./local-path";

/**
 * A deterministic, local-disk `StorageProvider` — the CI/test default and dev
 * fallback (no `BLOB_READ_WRITE_TOKEN` needed), so the whole upload→render flow
 * stays exercisable end-to-end with no real bucket. The real Vercel Blob adapter
 * (`vercel-blob.ts`) takes over only once a token is set (`getStorageProvider`).
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
    // The namespaced, collision-free key — the SAME shape the real Blob adapter
    // mints (`object-key.ts`), so both satisfy `addImage`'s `tenants/<tid>/` gate.
    const key = buildObjectKey(input);
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
