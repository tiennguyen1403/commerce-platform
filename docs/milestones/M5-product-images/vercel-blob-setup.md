# Vercel Blob setup — operator prerequisite + manual smoke test

The `VercelBlobStorageProvider` adapter (`src/server/storage/vercel-blob.ts`, M5 #189) is a
thin client over Vercel Blob's **presigned-URL** primitives (`issueSignedToken` + `presignUrl`

- `del`, from the server-only `@vercel/blob` entry). The app never provisions a Blob store —
  that's a one-time **operator prerequisite**, the same category as M3's wildcard-domain hosting
  and M4's Printful account. This doc is what an operator does once to turn real image storage
  on, plus a free manual smoke test to verify the integration against a live store.

> Until `BLOB_READ_WRITE_TOKEN` is set, the storage selector (`getStorageProvider`) falls back
> to the deterministic **local-disk mock** in dev/test (bytes under `public/uploads/**`, served
> static) and returns **null** (not-configured → `StorageNotConfiguredError` at the upload
> boundary) in production. CI never talks to Vercel Blob. Nothing below is required to build or
> test the app — the whole upload→render flow is exercisable with no token and no real bucket.

## How it works (why there's no webhook)

The browser uploads bytes **straight to Blob storage** with a bare
`fetch(uploadUrl, { method: "PUT", headers: { "content-type": … }, body: file })` — never
through a Server Action (which caps bodies at ~1 MB). The server mints that `uploadUrl` per
upload:

1. `issueSignedToken` (a server→control-API call, authed by `BLOB_READ_WRITE_TOKEN`) mints a
   delegation scoped to **exactly one object**: this pathname, `put` only, this content type,
   this size ceiling.
2. `presignUrl` (local HMAC, no network) turns it into a one-off presigned `PUT` URL. The CDN
   verifies the signature and rejects anything outside the delegation's scope — so the URL is
   safe to hand a browser.
3. The finished object's public URL is
   `https://<storeId>.public.blob.vercel-storage.com/<key>` — deterministic because we sign
   with `addRandomSuffix: false` (our key already carries a UUID).

We deliberately do **not** use the `handleUpload` / `handleUploadPresigned` route flow: it
learns the final URL from an `onUploadCompleted` webhook, and there's no public callback tunnel
in dev/CI. See Vercel's [Signed URLs](https://vercel.com/docs/vercel-blob/vercel-signed-urls)
docs (the `PUT` example is exactly the shape `product-image-manager.tsx` sends).

## Operator prerequisite (one-time)

1. **Create one Blob store.** In the [Vercel dashboard](https://vercel.com/dashboard) →
   **Storage** → **Create Database** → **Blob**. One store serves the whole app (storage is
   per-platform, not per-tenant — object keys namespace tenants as `tenants/<tenantId>/…`).
2. **Keep it public.** The store must serve objects at
   `https://<storeId>.public.blob.vercel-storage.com/…` so `next/image` can fetch them with no
   per-request auth. That host is already allowlisted in `next.config.ts`
   (`images.remotePatterns` → `*.public.blob.vercel-storage.com`), so **no config change is
   needed** — a private store would not render.
3. **Connect the store to the project.** Vercel then injects `BLOB_READ_WRITE_TOKEN` into the
   project's environment automatically (Production/Preview). Treat the token as a secret — it is
   read-write. Never expose it via `NEXT_PUBLIC_*`; it is read only inside
   `src/server/storage/**`.
4. **Set the token locally** (only to develop or smoke-test against the real store). Pull it
   with `vercel env pull` or copy it from the store's **Tokens** tab into `.env` (see
   `.env.example`). Optional, validated at use — a missing/blank value never blocks boot (the
   `PRINTFUL_API_KEY` posture): dev/test just falls back to the mock.

## Manual smoke test — a real upload against a live store

Vercel Blob has no sandbox and no free "draft" (unlike Printful). A smoke test is a **real
upload**; storage of a handful of small test images is negligible, and you delete them at the
end. Run it once when wiring up a new store, or when `@vercel/blob` changes.

1. **Set the token and start the app** against it:

   ```bash
   # In .env (see .env.example):
   BLOB_READ_WRITE_TOKEN="vercel_blob_rw_<storeId>_<secret>"
   ```

   ```bash
   pnpm build && pnpm start   # or pnpm dev
   ```

2. **Upload through the admin manager.** Sign in to `/admin`, open a product in **edit** mode,
   and add an image in the **Images** card. On success it appears in the manager. Confirm end to
   end:
   - The stored URL is `https://<storeId>.public.blob.vercel-storage.com/tenants/<tenantId>/products/<productId>/<uuid>-<slug>.<ext>`
     (inspect the thumbnail's `src`, or the `ProductImage.key`/`url` in `pnpm db:studio`).
   - The storefront renders it via `next/image` (the product card + PDP gallery) — proving the
     `remotePatterns` host is correct. A missing/wrong host shows a broken image and a
     `next/image` "hostname not configured" error in the server logs.
   - **Delete** the image in the manager → the object is removed from the store (verify in the
     Vercel dashboard's Blob browser, or with `vercel blob list`). The DB row is authoritative,
     so a delete removes the row first and the object best-effort — an orphaned object never
     fails the operation.

3. **Verify the fallbacks.** Blank the token (`BLOB_READ_WRITE_TOKEN=""`) and restart: dev/test
   returns to the mock (`/uploads/…` URLs), and a production build with no token surfaces
   `StorageNotConfiguredError` when an admin tries to upload — never a crash.

4. **Clean up.** Delete any test images you added (via the manager, the dashboard, or
   `vercel blob del <url>`), then revert `.env` to the mock default (unset/blank token) unless
   you're intentionally developing against the real store.

## What the adapter does not do (by design)

- **No image transcode / no `sharp`.** v1 stores and serves the original bytes; a real
  `https://` Blob URL is optimized by Vercel's platform image optimization in production. Under a
  plain `next start` (no Vercel), `/_next/image` would need `sharp` — but real Blob URLs only
  occur when a token is set (i.e. on Vercel), and the local mock's same-origin `/uploads/…` URLs
  render `unoptimized` (`isUnoptimizedImageSrc`), so CI/dev never need `sharp`. (No blur
  placeholder either — deferred; see `GOAL.md`.)
- **Tightest per-upload token scope, not a cached broad one.** The docs suggest caching one
  broad token across uploads to skip a round trip; we instead issue a token scoped to the single
  object per upload (narrowest grant — a leaked URL can overwrite nothing else). Admin uploads
  are low-volume (≤ `MAX_IMAGES_PER_PRODUCT` per product), so the extra `issueSignedToken` call
  is a fair trade for the tighter scope.
- **One platform store, tenant-namespaced keys.** Per-tenant buckets/credentials are not used;
  isolation is enforced by the `tenants/<tenantId>/…` key prefix and the service's re-pin of the
  client-echoed key (golden rule 1), not by separate stores.

## References

- `src/server/storage/vercel-blob.ts` — the adapter (presigned-URL flow, response validation).
- `src/server/storage/index.ts` — the selector (`BLOB_READ_WRITE_TOKEN` → this adapter).
- `src/lib/env.ts` — `BLOB_READ_WRITE_TOKEN` (optional, validated at use).
- `next.config.ts` — `images.remotePatterns` for the public Blob host.
- `docs/milestones/M5-product-images/research.md` — provider evaluation + the Blob decision.
- Vercel Blob: <https://vercel.com/docs/vercel-blob> · Signed URLs:
  <https://vercel.com/docs/vercel-blob/vercel-signed-urls>
