import "server-only";
import { randomUUID } from "node:crypto";
import {
  type AllowedImageContentType,
  IMAGE_CONTENT_TYPE_EXTENSIONS,
} from "@/lib/validators/catalog";
import type { GetUploadUrlInput } from "./provider";

/**
 * The one place the stored **object key** is shaped, shared by every
 * `StorageProvider` adapter (the local-disk `mock` and the real `vercel-blob`).
 * Both MUST mint keys of the identical form so the shape is a provider-independent
 * invariant, not a per-adapter accident:
 *
 *   tenants/<tenantId>/products/<productId>/<random>-<slug>.<ext>
 *
 * That leading `tenants/<tenantId>/` is load-bearing: `imageService.addImage`
 * re-pins the client-echoed key to exactly this prefix (golden rule 1), so a key
 * that didn't start there would be rejected as tampered. Keeping the builder here —
 * rather than copied into each adapter — means the mock and Blob can never drift
 * into producing keys the service would refuse. Server-only: uses `node:crypto`.
 */

/**
 * Stored file extension for a content type, so the object's name carries an
 * extension that matches its bytes (`.png`/`.jpg`/`.webp`). Uses the shared
 * allowlist→extension map; anything off the upload allowlist
 * (`ALLOWED_IMAGE_CONTENT_TYPES`, enforced upstream at sign time) can only reach
 * here via a direct/test call, so it falls back to a neutral `bin` rather than
 * trusting the caller's file name for an extension.
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
 * Build the namespaced, collision-free object key for one upload. The random
 * component comes FIRST (after the namespace), so the key is unique even for
 * repeat uploads of the same file name — no store ever clobbers, and the real
 * provider is signed with `addRandomSuffix: false` precisely because this UUID
 * already guarantees uniqueness. `tenantId`/`productId` are DB cuids, so the key
 * is separator-free by construction (the local sink still re-validates it), and
 * every character it can contain (`[a-z0-9-]`, `/`, `.`) is URL-safe, so it drops
 * verbatim into both a `/uploads/…` path and an `https://…/<key>` Blob URL.
 */
export function buildObjectKey(input: GetUploadUrlInput): string {
  const extension = extensionForContentType(input.contentType);
  const slug = safeFileNameSlug(input.fileName);
  return `tenants/${input.tenantId}/products/${input.productId}/${randomUUID()}-${slug}.${extension}`;
}

/**
 * True iff `key` is a **traversal-free** object key: every `/`-separated segment is
 * non-empty and is not `.`/`..` and carries no `\` or NUL byte — so the key can never
 * step out of its `tenants/<tenantId>/…` namespace on ANY provider. This is the same
 * per-segment rule `resolveLocalUploadPath` (`local-path.ts`) enforces at the local
 * sink's filesystem boundary; keeping it here too means the invariant is shared rather
 * than living only in the mock's resolver.
 *
 * `buildObjectKey` always produces a key that satisfies this (cuid tenant/product ids,
 * a UUID, and a `[a-z0-9-]` slug — no traversal segment can occur), so it is a no-op
 * for a well-formed key. It exists for the ONE untrusted entry point: `addImage`
 * re-checks a client-echoed key against it (alongside the `tenants/<tenantId>/` prefix
 * pin) before the key can be stored and later reach `provider.delete(key)`. A
 * prefix-only check would pass a key like `tenants/<me>/../<victim>/…` — starts with
 * the right prefix, yet an interior `..` names another tenant's namespace — which the
 * Vercel Blob adapter's `del` would forward verbatim (golden rule 1).
 */
export function isSafeObjectKey(key: string): boolean {
  const segments = key.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !segment.includes("\\") &&
      !segment.includes("\0"),
  );
}
