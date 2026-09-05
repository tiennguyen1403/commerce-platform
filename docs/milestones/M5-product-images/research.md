# Research — M5 Product images

> Produced at milestone start (by the `researcher` agents, synthesized by the main session).
> Read before building. See [`GOAL.md`](GOAL.md).

## Context & goal

Products have **no images today** — every storefront surface (product card, listing, search,
and the PDP) renders a muted `lucide-react` `ImageIcon` placeholder
(`src/app/(storefront)/products/product-card.tsx:42-49`,
`src/app/(storefront)/products/[slug]/page.tsx:74-84`). M5 adds a real `ProductImage` model,
an admin upload/reorder/caption/delete flow, and `next/image` rendering everywhere, with a
graceful placeholder fallback for image-less (i.e. every existing) products. It is a
**data/feature** milestone that fills the gallery/card slots the parallel **Claude Design**
UI-redesign track builds (the PDP gallery placeholder shipped in PR #183 is the slot to wire).
The M1–M4 rules hold: tenant-isolated, layered (UI/route → service → repository → Prisma),
money stays integer cents, server-only stays server-only.

## Key questions (and answers)

- **Storage provider?** → **Vercel Blob**, presigned-URL flow. (Runner-up: Cloudflare R2, behind
  the same seam.) See [Decision](#decision-vercel-blob-presigned-url-via-a-server-action).
- **How do image bytes get to storage without a 1MB Server Action limit?** → the browser does a
  bare `PUT` directly to storage against a short-lived **presigned URL**; bytes never touch a
  Server Action.
- **How does CI render an uploaded image with no real bucket?** → a `StorageProvider` **seam**
  (mirroring the M4 fulfillment provider seam) with a **local-disk mock** as the dev/test/CI
  default, rendered `unoptimized` so the `sharp`-requiring optimizer is never hit.
- **Where do width/height/blur come from for a remote `next/image`?** → dims measured
  **client-side** before upload and persisted; **blur is deferred** (CSS shimmer instead), which
  keeps `sharp` out of the dependency tree entirely for v1.

## Decision: Vercel Blob, presigned-URL via a Server Action

Confirmed against fresh Vercel docs + npm (`@vercel/blob@2.8.0`, GA, `engines.node >=20`, **zero
peer deps** — trivially safe on React 19.2.8 / Next 16.3.3).

- **Why Vercel Blob:** lowest total friction for an app that already deploys on Vercel — no new
  account, no DNS, a free tier with a **hard, non-billing cap** (no overage charges, no
  inactivity auto-pause — unlike Supabase's 7-day pause or UploadThing's 2 GB-shared floor). Its
  newer **presigned-URL** primitives (`issueSignedToken` + `presignUrl`, from the server-only
  `@vercel/blob` package — _not_ `/client`) are genuinely S3-shaped and callable from a **plain
  Server Action**, so the whole feature fits this repo's all-Server-Action admin-mutation
  convention with **zero new Route Handlers, no webhook, no ngrok**.
- **Do NOT use `onUploadCompleted`.** Vercel Blob's webhook (the "natural" place to persist a
  row) is a callback Vercel POSTs over the public internet — it **does not fire on localhost/CI**
  without a tunnel. Instead: browser PUTs the file, then immediately calls a second Server Action
  with `{ url, key, width, height }` to persist the `ProductImage` row. This keeps the write on
  the same `requireAdminContext → zod → service → repository` path as every other mutation.
- **Runner-up — Cloudflare R2** (S3 presigned PUT via `@aws-sdk/client-s3` +
  `s3-request-presigner`): the stronger CV signal (portable S3 flow, free egress) but more setup
  (Cloudflare account; public-read in prod needs a **custom domain on Cloudflare DNS**; heaviest
  SDK — though Next auto-externalizes `@aws-sdk/client-s3` via `serverExternalPackages`; no
  server-enforced size cap at sign time). The `StorageProvider` seam makes swapping to R2 a
  one-adapter change — schema, service, repository, and UI are untouched.
- **Not recommended:** UploadThing (SaaS that hides the very upload mechanics this milestone is
  about; real dollar floor) and Supabase Storage (access control assumes Supabase Auth, not
  Better Auth; free-tier auto-pause threatens "looks production-real").

## Findings

### Framework / APIs (Next 16.3.3 — verified against the installed docs)

- **Server Action body limit = 1 MB default** (`serverActions.md:27-45`), configurable via
  `experimental.serverActions.bodySizeLimit`. Raising it to accept multi-MB photos defeats the
  purpose (no CDN offload, DDoS surface — the doc frames the default as DDoS protection). This is
  the forcing function for **client-direct upload**; `next.config.ts` needs _no_
  `serverActions` change — we simply never route image bytes through a Server Action.
- **Route Handler is NOT required.** Minting a presigned URL is a plain server function call →
  fits a Server Action. Node is the default runtime; **Edge is deprecated** for route config
  (`route-segment-config/07-edge.md`). (A Route Handler is only forced by UploadThing's SDK, or
  by Vercel Blob's webhook flow — neither of which we use, except the local mock's upload sink,
  below.)
- **`images.remotePatterns`** is the correct, non-deprecated config (`domains` deprecated since
  Next 14) — `next.config.ts` has **no `images` block today** and needs one for the Blob host
  (`{ protocol: "https", hostname: "*.public.blob.vercel-storage.com" }`; wildcards only at
  hostname start / pathname end). An unmatched host → **HTTP 400**, not a silent degrade
  (`image.md:563`).
- **Two Next 16 traps (differ from training data):**
  1. `next/image` **`priority` is deprecated in Next 16.0.0 → use `preload`** (`image.md:291-293`).
     Apply to LCP images (PDP main image, first card image).
  2. A **remote** `src` requires `width`/`height` supplied manually (and `blurDataURL` if
     `placeholder="blur"`) — Next has no access to remote files at build time
     (`image.md:1243-1244`). This makes storing dims a **hard requirement**, not polish.
- **`sharp`:** the on-demand optimizer `require('sharp')` and **throws** if missing (verified in
  source `node_modules/next/dist/server/image-optimizer.js:197-238`; the old Squoosh fallback is
  fully removed in Next 16). On Vercel, prod `/_next/image` is optimized by Vercel's
  infrastructure (no `sharp` in our bundle). For CI/local (`next start` in the Playwright job),
  rendering any optimized image hits that throw — so we render mock/local images **`unoptimized`**
  and **do not install `sharp`** for v1.

### Libraries / services

- **`@vercel/blob@2.8.0`** — server package only. Key calls: `issueSignedToken` / `presignUrl`
  (mint a presigned PUT), `del(url|key)` (delete — **free**, no-throw on missing). Token env:
  `BLOB_READ_WRITE_TOKEN` (server-only).
- **No `sharp`, no `plaiceholder`, no `@aws-sdk/*` installed** — and v1 needs none. Adding
  `@vercel/blob` is the milestone's one new dependency (justified: the chosen storage SDK, tiny,
  0 peer deps — satisfies CLAUDE.md's "note why").
- **Dims client-side:** read `naturalWidth`/`naturalHeight` off `new Image()` (or
  `createImageBitmap(file)`) before the PUT — zero deps, zero server compute; the client already
  holds the file.

### Patterns to follow (from the codebase — cite `path:line`)

- **The provider seam to mirror** — `src/server/fulfillment/{provider.ts,index.ts,mock.ts}`:
  an interface, a selector keyed purely on secret presence (`getFulfillmentProvider()`,
  `index.ts:48-56`: real key → real adapter; non-prod, no key → **mock (CI/test default)**; prod,
  no key → `null` → typed `*NotConfiguredError`). Build `src/server/storage/**` the same shape:
  ```ts
  interface StorageProvider {
    readonly name: string;
    getUploadUrl(input: {
      tenantId;
      productId;
      contentType;
      fileName;
    }): Promise<{ uploadUrl: string; publicUrl: string; key: string }>;
    delete(key: string): Promise<void>; // best-effort
  }
  ```
  **New wrinkle vs. fulfillment:** the fulfillment mock returns canned strings — but an image
  mock must expose **real bytes** for the browser/`next/image` to fetch. Mock design: a
  dev/test-only sink (a tiny same-origin `PUT /api/uploads/local/[...key]` route that writes
  under `public/uploads/**`, served static + `unoptimized`), with `getUploadUrl` returning that
  route's URL and a root-relative `publicUrl`. Root-relative paths are **not** gated by
  `remotePatterns` (that's external-URL-only, `match-local-pattern.js:37-40`), so the mock needs
  no `next.config.ts` change and renders without `sharp` when `unoptimized`.
- **Optional server-only secret** — `src/lib/env.ts:13-16,36,53`: `optionalEnvString` (optional,
  trimmed→undefined, validated at _use_ not boot, never `NEXT_PUBLIC_*`). Add
  `BLOB_READ_WRITE_TOKEN: optionalEnvString`; throw `StorageNotConfiguredError` at the write
  boundary in prod when absent (mirrors `EmailNotConfiguredError` / `FulfillmentNotConfiguredError`).
- **Business-rule caps are NOT env** — `MAX_IMAGE_SIZE_BYTES`, `MAX_IMAGES_PER_PRODUCT`, and the
  content-type allowlist (`image/jpeg|png|webp`) are constants (house convention:
  `src/config/constants.ts` holds `LOW_STOCK_THRESHOLD`; `src/lib/validators/catalog.ts` holds
  `MAX_PRICE_CENTS`/`MAX_STOCK`).
- **Double-parse idempotency** — the admin form parses raw input, then the Server Action
  **re-parses `parsed.data`** with the same schema (`actions.ts:73,95`). Any new field's zod
  schema must be **idempotent** (output = `string | undefined`, never `null` — precedent
  `providerVariantId`, `catalog.ts:75-79`); the form sends `x.trim() || undefined`; the
  repository collapses blank→null with `|| null` (`product.repository.ts:221`).
- **Circular return-type gotcha** — type image-bearing reads with a **standalone**
  `Prisma.ProductGetPayload<{ include: { variants: true; images: true } }>`, never
  `ReturnType<typeof repo.method>` (collapses the repo to `any`, TS7022/TS2456 —
  `product.repository.ts:49-52`).
- **Layering + tenant scope for writes** — new repo methods take `tenantId` first and put it in
  the Prisma `where` (like `archive(tenantId, id)`, `product.repository.ts:370-376`); service
  orchestrates (count-cap + storage + persist); Server Action calls the service then
  `revalidateCatalog(storeSlug, slug)` (`actions.ts:27-33`).

### Data + schema

Confirmed **no image field/model exists** (full `prisma/schema.prisma` read). Proposed model,
consistent with house conventions (cuid ids, `@updatedAt`, explicit `@@index`, cascade from
parent):

```prisma
model ProductImage {
  id          String   @id @default(cuid())
  tenantId    String   // own tenantId (Golden Rule 1 + storage-key namespacing);
                       // a DELIBERATE divergence from ProductVariant, which has none
  productId   String
  url         String   // public URL for rendering
  key         String   // provider-opaque storage key/pathname, for clean deletes + portability
  altText     String?
  position    Int      // display order; create path always computes it (0,1,2,…)
  width       Int?     // captured client-side; load-bearing for next/image remote src
  height      Int?
  blurDataUrl String?  // reserved; unused in v1 (blur deferred to a CSS shimmer)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  tenant  Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  product Product @relation(fields: [productId], references: [id], onDelete: Cascade)

  @@index([productId, position])
  @@index([tenantId])
}
```

Plus back-relations `Product.images ProductImage[]` and `Tenant.productImages ProductImage[]`.
**Migration is the cleanest possible case:** a wholly new table → the "`NOT NULL` needs a
`DEFAULT`" guard (`docs/DATABASE.md:12-20`) doesn't even apply; existing products just have zero
rows. Wire `images: { orderBy: { position: "asc" } }` into the includes feeding
`listActiveByTenant` / `searchActiveByTenant` / `findBySlug` / `findByIdForTenant`.

### The upload flow (end to end)

1. Admin opens a **saved** product (edit mode) → picks files in a new image-manager Card in
   `product-form.tsx` (create mode has no `productId` yet → uploader gated to edit).
2. Client reads each file's dims (`new Image()`), validates type/size client-side (soft guard).
3. **Server Action #1** (`requireAdminContext(storeSlug)` → zod: content-type allowlist, size
   cap, **per-product count cap** via a DB count) → returns a short-lived **presigned PUT URL**
   for key `tenants/<tenantId>/products/<productId>/<cuid>.<ext>`.
4. Browser `fetch(uploadUrl, { method: "PUT", body: file, headers: { "content-type": … } })`
   directly to Blob.
5. **Server Action #2** persists the `ProductImage` row (`url, key, width, height, altText,
position`) → `revalidateCatalog`.
6. **Reorder** = rewrite `position` for the set; **delete** = remove row + **best-effort**
   `storage.delete(key)` (log-and-continue on failure).

### Tests

- **Unit** (`vitest`, `unit` project): mock `imageRepository` + the `StorageProvider` (same style
  as `catalog.service.test.ts:18-26`).
- **Integration** (`*.integration.test.ts`, real Postgres 55432, serial, throwaway tenant via
  `createTestTenant`/`deleteTenantDeep`): upload→reorder→delete + tenant isolation. **Extend
  `deleteTenantDeep`** to `deleteMany` `productImage` before `product` (`integration-db.ts:64-65`).
- **E2E** (Playwright vs `pnpm build && pnpm start`, `workers:1`): admin upload → the storefront
  card/PDP renders an `<img>`/`next/image` in place of the `ImageIcon`. **Runs against the mock
  provider only** (no real bucket/token in CI — the same posture as Stripe-free/Resend-free jobs,
  `ci.yml`), rendered `unoptimized` so the job needs no `sharp`.

## Risks & unknowns

| Risk / question                                        | Mitigation                                                                                                      |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Bytes through a 1MB Server Action fail                 | Never do it — client PUTs to a presigned URL.                                                                   |
| CI render needs `sharp`                                | Mock/local images render `unoptimized`; don't install `sharp` v1.                                               |
| `next/image` 400 on unlisted host                      | Add Blob host to `remotePatterns`; mock uses root-relative paths (ungated).                                     |
| Object uploaded, row never persisted (client vanishes) | Accept the rare orphan; namespaced keys make a future cleanup cron trivial. Don't adopt the ngrok-only webhook. |
| Row deleted, object lingers                            | Best-effort `del(key)` in the delete service call; free + no-throw.                                             |
| Uploader has no `productId` in create mode             | Gate uploader to edit mode (save product once first).                                                           |
| `priority` deprecated                                  | Use `preload` for LCP images.                                                                                   |
| Stale `docs/lovable/…` reference in the old draft      | Removed — the real slot is the PR #183 PDP placeholder; UI track is now Claude Design.                          |
| Provider lock-in                                       | The `StorageProvider` seam isolates it; swap to R2 = one adapter.                                               |

## Recommended approach (build order)

1. **Schema first** — `ProductImage` migration (additive, no backfill) + seed a few demo images
   (committed sample files under `public/seed/`, provider-independent) + `docs/DATABASE.md`.
2. **Storage seam + config** — `src/server/storage/{provider.ts,index.ts,mock.ts}` (interface +
   env-keyed selector + local-disk mock incl. its `PUT /api/uploads/local/[...key]` dev sink) +
   `BLOB_READ_WRITE_TOKEN` in `env.ts`/`.env.example` + `StorageNotConfiguredError`. Unblocks
   everything against the mock — no real provider yet.
3. **Repository + service** — tenant-scoped `create`/`list-ordered`/`reorder`/`delete` (standalone
   GetPayload types) + `imageService` (count-cap → presign → persist → reorder → delete); wire
   `images` into the product includes. Unit + integration tests.
4. **Admin uploader UI + Server Actions** — the image-manager Card (edit mode) + presign/persist/
   reorder/alt/delete actions (idempotent schemas, `requireAdminContext`).
5. **Storefront rendering** — swap `ImageIcon` in `product-card.tsx` (shared /products + /search)
   and build the real **PDP gallery** (main + thumbnail rail) in `[slug]/page.tsx`; empty-set
   fallback; `preload` LCP; `unoptimized` heuristic for local/mock; add `remotePatterns`.
6. **Real Vercel Blob adapter + operator setup** — the real adapter behind the seam;
   `remotePatterns` host; an operator prerequisite doc (`vercel-blob-setup.md`, mirroring
   `printful-setup.md`); manual smoke test.
7. **E2E + architecture docs** — the upload→render Playwright E2E (mock only); `docs/ARCHITECTURE.md`
   media section + decision-log entry.

Steps 4 and 5 can run in parallel after 3 (5 uses mock/demo images). Build against the mock first,
wire real Blob second, land the E2E last once both paths agree on the `StorageProvider` contract.

## References

**Repo:** `prisma/schema.prisma:145-213` · `src/server/fulfillment/{provider,index,mock}.ts` ·
`src/lib/env.ts:13-16,36,45-53` · `src/app/(admin)/admin/[storeSlug]/products/{product-form.tsx,actions.ts}` ·
`src/lib/validators/catalog.ts:75-79` · `src/server/repositories/product.repository.ts:49-52,156-181,370-376` ·
`src/server/services/catalog.service.ts` · `src/app/(storefront)/products/{product-card.tsx:42-49,[slug]/page.tsx:74-84}` ·
`src/config/constants.ts` · `vitest.config.mts` · `src/test/integration-db.ts:37-67` ·
`playwright.config.ts` · `.github/workflows/ci.yml` · `next.config.ts`

**Next 16 docs (installed `node_modules/next/dist/docs/`):**
`01-app/03-api-reference/05-config/01-next-config-js/serverActions.md` (bodySizeLimit) ·
`.../images.md` + `01-app/03-api-reference/02-components/image.md` (remotePatterns, preload,
remote width/height, blurDataURL, unoptimized) ·
`.../serverExternalPackages.md` (`@aws-sdk/client-s3` allowlist) ·
`01-app/02-guides/{server-actions.md,self-hosting.md}` · route-segment-config `07-edge.md`.
Source-of-truth: `node_modules/next/dist/server/image-optimizer.js:197-238` (sharp required),
`node_modules/next/dist/shared/lib/match-local-pattern.js:37-40` (local paths ungated).

**External:** Vercel Blob — [Client Uploads](https://vercel.com/docs/vercel-blob/client-upload) ·
[Signed URLs](https://vercel.com/docs/vercel-blob/vercel-signed-urls) (`issueSignedToken`/`presignUrl`) ·
[SDK](https://vercel.com/docs/vercel-blob/using-blob-sdk) ·
[Pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing). Runner-up — Cloudflare R2
[presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) +
[public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/). Versions verified
via npm: `@vercel/blob@2.8.0`, `sharp@0.35.4`, `@aws-sdk/client-s3@3.1127.0`.
