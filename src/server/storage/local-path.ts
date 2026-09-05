import "server-only";
import path from "node:path";

/**
 * Filesystem plumbing shared by the local-disk storage mock (`mock.ts`, which
 * `delete`s objects) and its dev/test upload sink
 * (`app/api/uploads/local/[...key]/route.ts`, which writes them). Both turn a
 * provider key into an absolute path under `public/uploads/**` through the SAME
 * traversal-safe resolver, so there is one place the "a key can never escape the
 * uploads dir" invariant is enforced. Server-only: touches `process.cwd()` and is
 * only ever used from filesystem code paths.
 */

/**
 * Root the local mock writes under. `public/` is served static by Next, so an
 * object at `public/uploads/<key>` is reachable at `/uploads/<key>` — the mock's
 * `publicUrl`. `process.cwd()` is the project root under `next dev`/`next start`
 * and `pnpm test`, which is the only place this dev/test sink ever runs.
 */
export const PUBLIC_UPLOADS_DIR = path.join(process.cwd(), "public", "uploads");

/** Root-relative prefix the finished image is served from (`publicUrl`). */
export const LOCAL_PUBLIC_URL_PREFIX = "/uploads";

/** Same-origin route the browser `PUT`s the raw bytes to (`uploadUrl`). */
export const LOCAL_UPLOAD_SINK_PREFIX = "/api/uploads/local";

/**
 * Thrown when a key cannot be safely resolved to a path inside
 * `PUBLIC_UPLOADS_DIR` — an empty key, or one carrying a `.`/`..`/separator/NUL
 * segment that could escape the uploads tree. The sink route maps it to a 400; the
 * mock's best-effort `delete` swallows it. A distinct type so a caller can tell an
 * unsafe key apart from a genuine filesystem failure.
 */
export class UnsafeUploadKeyError extends Error {
  constructor(key: string) {
    super(`Unsafe upload key: ${JSON.stringify(key)}`);
    this.name = "UnsafeUploadKeyError";
  }
}

/**
 * Resolve a provider key (e.g. `tenants/t1/products/p1/abc.png`) to the absolute
 * file path it maps to under `PUBLIC_UPLOADS_DIR`, refusing anything that could
 * escape that root. The security boundary for the file-writing dev sink: the key
 * ultimately comes from a URL path (`[...key]`), so it is treated as hostile.
 *
 * Two independent layers, either of which alone rejects a traversal:
 *   1. per-segment — reject `.`, `..`, empty, or a segment carrying a path
 *      separator (`/` or `\`) or a NUL byte (a truncation trick);
 *   2. containment — after resolving, require the result to sit inside the root
 *      (`path.relative` yields neither a `..`-leading nor an absolute path).
 *
 * @throws {UnsafeUploadKeyError} if the key is empty or escapes the uploads root.
 */
export function resolveLocalUploadPath(key: string): string {
  const segments = key.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new UnsafeUploadKeyError(key);
  }
  for (const segment of segments) {
    if (
      segment === "." ||
      segment === ".." ||
      segment.includes("\\") ||
      segment.includes("\0")
    ) {
      throw new UnsafeUploadKeyError(key);
    }
  }
  const absolutePath = path.resolve(PUBLIC_UPLOADS_DIR, ...segments);
  const relative = path.relative(PUBLIC_UPLOADS_DIR, absolutePath);
  // Escapes the root iff `relative` steps up (`..` exactly, or a `..`-then-separator
  // prefix) or is absolute (a Windows drive-letter reset). The precise `..` form —
  // rather than a bare `startsWith("..")` — avoids falsely rejecting a legitimately
  // nested segment that merely begins with `..` (e.g. a dir literally named `..foo`).
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new UnsafeUploadKeyError(key);
  }
  return absolutePath;
}
