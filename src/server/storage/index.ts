import "server-only";
import { env } from "@/lib/env";
import type { StorageProvider } from "./provider";
import { MockStorageProvider } from "./mock";

/**
 * The storage module's public surface: the provider abstraction + the selector that
 * picks the live provider. Everything outside `src/server/storage` depends only on
 * these — never on a concrete adapter — so swapping Vercel Blob for a mock (or R2)
 * touches no catalog/admin code, per `provider.ts`'s promise. The exact mirror of
 * `src/server/fulfillment/index.ts`.
 */
export type {
  GetUploadUrlInput,
  GetUploadUrlResult,
  StorageProvider,
} from "./provider";
export { MockStorageProvider } from "./mock";

// Lazily-constructed singleton (the `getStripe`/`getFulfillmentProvider` pattern).
let mockSingleton: MockStorageProvider | null = null;

/**
 * Resolve the active storage provider, keyed off `BLOB_READ_WRITE_TOKEN` presence:
 *
 * - no token, dev/test → the local-disk `MockStorageProvider` — the CI default and
 *   dev fallback, so the whole upload→render flow is exercisable with no token and
 *   no real bucket;
 * - no token, production → `null`: storage is genuinely not configured, which the
 *   calling service surfaces as `StorageNotConfiguredError`.
 *
 * The real Vercel Blob adapter — the `token set → real provider (any environment)`
 * branch, keyed on the token exactly as `getFulfillmentProvider` keys on
 * `PRINTFUL_API_KEY` — is added in M5-06 at the TOP of this function:
 *
 *   if (env.BLOB_READ_WRITE_TOKEN) return (blobSingleton ??= new BlobStorageProvider());
 *
 * Until that adapter is built there is nothing to construct for a set token, so a
 * token does not yet change the outcome (dev/test still gets the mock, prod still
 * gets `null`); the M5-06 change is a pure prepend. The prod/non-prod split is
 * deliberate and matches fulfillment: the mock must never write to a real
 * deployment's read-only `public/` tree, but a missing token must never block boot
 * (the optional-secret posture — validated at use, not boot). The caller decides
 * what a `null` means for its flow; here it is always the not-configured signal.
 */
export function getStorageProvider(): StorageProvider | null {
  if (env.NODE_ENV !== "production") {
    return (mockSingleton ??= new MockStorageProvider());
  }
  return null;
}
