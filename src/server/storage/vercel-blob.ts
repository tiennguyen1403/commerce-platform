import "server-only";
import {
  del,
  issueSignedToken,
  parseStoreIdFromDelegationToken,
  presignUrl,
} from "@vercel/blob";
import { z } from "zod";
import { env } from "@/lib/env";
import { MAX_IMAGE_SIZE_BYTES } from "@/lib/validators/catalog";
import type {
  GetUploadUrlInput,
  GetUploadUrlResult,
  StorageProvider,
} from "./provider";
import { buildObjectKey } from "./object-key";

/**
 * Vercel Blob adapter — the real object store behind the `StorageProvider` seam
 * (M5 #189), swapped in purely by `BLOB_READ_WRITE_TOKEN` presence in
 * `getStorageProvider` (`index.ts`), exactly as `PrintfulProvider` is swapped in by
 * `PRINTFUL_API_KEY`. Everything above the seam (the image service, the admin
 * manager, the storefront render) is already built and mock-tested; this is the
 * live provider, so nothing else changes when it turns on.
 *
 * A thin client over Vercel's **presigned-URL** primitives (`@vercel/blob`, the
 * server entry — NOT `@vercel/blob/client`), verified against the live SDK
 * (`@vercel/blob@2.8.0`) and docs (`/docs/vercel-blob/vercel-signed-urls`,
 * last-updated 2026-07-08). Deliberately NOT the `handleUpload`/`handleUploadPresigned`
 * route flow: that relies on an `onUploadCompleted` webhook to learn the final URL,
 * and there is no public callback tunnel in dev/CI. Instead, one `getUploadUrl` call:
 *
 *   1. `issueSignedToken` (a server→control-API round trip authed by the RW token)
 *      mints a delegation scoped to EXACTLY this one object: this pathname, `put`
 *      only, this content type, this size ceiling — the narrowest grant possible, so
 *      a leaked URL can overwrite nothing else. (The docs suggest caching a broader
 *      token across uploads; we trade that round trip for the tighter scope — admin
 *      uploads are low-volume, ≤ `MAX_IMAGES_PER_PRODUCT` per product.)
 *   2. `presignUrl` (local HMAC, no network) turns that delegation into the one-off
 *      presigned `PUT` URL the browser uploads to with a bare
 *      `fetch(url, { method: 'PUT', headers: { 'content-type' }, body })` — the exact
 *      shape `product-image-manager.tsx` already sends. `addRandomSuffix: false`
 *      keeps the stored pathname === our key, so (3) is deterministic.
 *   3. The finished object's public URL is `https://<storeId>.public.blob.vercel-storage.com/<key>`
 *      (see `next.config.ts` `remotePatterns`) — the store is public (operator setup).
 *
 * `delete` removes one object by its key (`del` accepts a bare pathname), best-effort
 * per the seam contract — the calling service log-and-continues on failure.
 */

/**
 * Cap on a single Blob **control-API** call (`issueSignedToken`, `del`). Both run
 * inside an interactive admin Server Action, so this bounds a *hung* call to a clean
 * error rather than letting it ride the platform's function timeout — the
 * `PrintfulProvider` posture (`AbortSignal.timeout`). `presignUrl` is local HMAC (no
 * network), so it takes none.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/** The store's public object host: a public blob at pathname `p` in store `s` is
 *  served at `https://<s>.public.blob.vercel-storage.com/<p>` (the SDK's own
 *  `constructBlobUrl`; mirrored by `next.config.ts`'s `remotePatterns` host). */
const BLOB_PUBLIC_HOST_SUFFIX = "public.blob.vercel-storage.com";

/** The store's access mode (`presignUrl` requires it, and it selects the `.public`
 *  vs `.private` host above). Our Blob store is created with public access so
 *  `next/image` can fetch objects with no per-request auth. */
const BLOB_ACCESS = "public" as const;

// The RW token grants `put` for one content type at a time (each sign is for one
// specific upload) and caps size at the same ceiling the service already enforced,
// so the CDN re-rejects an oversized or wrong-type body even if a URL is replayed.
const uploadConstraints = (contentType: string) => ({
  allowedContentTypes: [contentType],
  maximumSizeInBytes: MAX_IMAGE_SIZE_BYTES,
});

// Response-shape guards for the control-API's `issueSignedToken` reply — it is
// external input, so it's validated (repo convention, as the Printful adapter does)
// rather than trusted from the SDK's static types. Only the fields we consume are
// declared. `presignUrl` is local HMAC (not a network reply), but its one field is
// asserted the same way for a uniform, defensive boundary.
const issuedTokenSchema = z.object({
  delegationToken: z.string().min(1),
  clientSigningToken: z.string().min(1),
});
const presignResultSchema = z.object({ presignedUrl: z.string().min(1) });

export class VercelBlobStorageProvider implements StorageProvider {
  readonly name = "vercel-blob";

  async getUploadUrl(input: GetUploadUrlInput): Promise<GetUploadUrlResult> {
    const token = requireToken();
    const key = buildObjectKey(input);
    const constraints = uploadConstraints(input.contentType);

    // 1) Delegation scoped to exactly this object + operation + content type + size.
    const signed = issuedTokenSchema.parse(
      await issueSignedToken({
        token,
        pathname: key,
        operations: ["put"],
        abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...constraints,
      }),
    );

    // 2) The one-off presigned PUT URL. `addRandomSuffix: false` — our key already
    //    carries a UUID, so uniqueness is ours and the stored pathname stays === key,
    //    which is what makes (3)'s public URL predictable at sign time.
    const { presignedUrl } = presignResultSchema.parse(
      await presignUrl(
        {
          delegationToken: signed.delegationToken,
          clientSigningToken: signed.clientSigningToken,
        },
        {
          operation: "put",
          pathname: key,
          access: BLOB_ACCESS,
          addRandomSuffix: false,
          ...constraints,
        },
      ),
    );

    // 3) The public render URL. The store id is read from the delegation token
    //    (the SDK's own exported parser, on the authoritative signed payload) rather
    //    than by splitting the RW token by hand.
    const storeId = parseStoreIdFromDelegationToken(signed.delegationToken);

    return {
      uploadUrl: presignedUrl,
      publicUrl: `https://${storeId}.${BLOB_PUBLIC_HOST_SUFFIX}/${key}`,
      key,
    };
  }

  async delete(key: string): Promise<void> {
    // Best-effort by the seam contract; `del` is idempotent (a missing object is
    // success) and accepts a bare pathname (our stored `key`). A genuine failure
    // (network/auth/timeout) throws here and the calling service catches + logs it —
    // an orphaned object never fails the catalog delete that already removed the row.
    await del(key, {
      token: requireToken(),
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }
}

/**
 * The read-write token, read at call time. The selector only builds this provider
 * when the token is present, so an unset token here is a defense-in-depth guard (a
 * misconfiguration fails loudly rather than calling the Blob API unauthenticated) —
 * the `PrintfulProvider.getClient` posture. Keeping it out of the constructor leaves
 * construction side-effect-free (the selector can build it without touching env).
 */
function requireToken(): string {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new Error("BLOB_READ_WRITE_TOKEN is not configured");
  }
  return token;
}
