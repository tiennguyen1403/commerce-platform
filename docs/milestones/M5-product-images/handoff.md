# Handoff — M5 Product images

> Written at milestone close (by the `scribe` agent).

Gives products real photography end to end: an admin uploads, reorders, captions, and
deletes images on a saved product through a client-direct-to-storage flow (bytes never
touch a Server Action), a new `ProductImage` model persists them tenant-scoped behind a
`StorageProvider` seam (a deterministic local-disk mock in dev/test/CI, real Vercel Blob
in production), and the storefront renders them via `next/image` on the product card,
listing, search results, and a new PDP gallery — with a clean placeholder fallback for
every existing, image-less product. Scope held steady at 9 issues, unlike M4's 9→21: the
one late finding — a defense-in-depth key-traversal hardening (#201) surfaced by the
handoff security review — was fixed and merged into `development` at handoff (PR #202)
rather than shipped as a gap.

## Shipped

- **`ProductImage` schema + migration + demo seed** (#184, PR #192) —
  `prisma/schema.prisma:223-267`: a new model carrying its **own** `tenantId` (a
  deliberate divergence from `ProductVariant`, which has none) plus `url`/`key`
  (provider-opaque)/`altText`/`position`/`width`/`height`/`blurDataUrl` (reserved,
  unused in v1). The migration
  (`prisma/migrations/20260905195858_add_product_image/migration.sql`) is a single
  additive `CREATE TABLE` + two indexes + two cascading FKs — no `ALTER TABLE`, so the
  "`NOT NULL` needs a `DEFAULT`" guard doesn't even apply. `prisma/seed.ts:182-205`
  seeds 3 demo images (2 for `classic-tee`, 1 for `everyday-hoodie`) from committed
  files under `public/seed/`; `enamel-mug` is deliberately left image-less as the
  placeholder/E2E fixture.
- **`StorageProvider` seam + local-disk mock + config** (#185, PR #193) —
  `src/server/storage/provider.ts` defines the interface (`getUploadUrl`/`delete`);
  `getStorageProvider()` (`index.ts:46-54`) selects the real `VercelBlobStorageProvider`
  when `BLOB_READ_WRITE_TOKEN` is set, else the local-disk `MockStorageProvider` in
  dev/test (the CI default) or `null` in production — the exact mirror of the M4
  fulfillment provider seam. The mock's dev/test-only upload sink
  (`src/app/api/uploads/local/[...key]/route.ts`) writes bytes under
  `public/uploads/**`, guarded by `resolveLocalUploadPath`'s traversal-safe resolver, an
  image-extension allowlist, and a size cap; it 404s in production. `BLOB_READ_WRITE_TOKEN`
  is optional and server-only (`env.ts:63`).
- **Image repository + service; wired into 4 product reads** (#186, PR #194) —
  `src/server/repositories/image.repository.ts`: every method scoped
  `{tenantId, productId}`; `createImage`/`getImageCountForOwnedProduct` atomically
  re-verify the parent product belongs to the tenant in the same transaction (the
  cross-tenant-attachment gate), returning `null` rather than leaking.
  `src/server/services/image.service.ts` owns the business rules (content-type/size
  caps, the per-product count cap, the reorder-permutation guard, the traversal-safe key
  re-pin). `images: { orderBy: { position: "asc" } }` is wired into `listActiveByTenant`,
  `searchActiveByTenant`, `findBySlug`, and `findByIdForTenant`
  (`product.repository.ts:67,137,161,183`).
- **Admin image-manager UI + 5 Server Actions** (#187, PR #196) —
  `product-image-manager.tsx` (edit-mode only — a create-mode product has no
  `productId` yet) drives a client-orchestrated 3-step flow (presign → direct `PUT` →
  persist) against 5 actions in `actions.ts` (`getImageUploadUrlAction`,
  `addProductImageAction`, `reorderProductImagesAction`, `updateImageAltTextAction`,
  `deleteProductImageAction`), each behind `requireAdminContext`; image bytes never pass
  through an action. Mounted in `product-form.tsx:372` only when
  `mode === "edit" && productId && productSlug`.
- **Storefront rendering via `next/image`** (#188, PR #197) — a shared
  `ProductImageFrame` (`src/app/(storefront)/products/product-image.tsx`) renders
  `next/image` with `fill`+`object-cover`, or the lucide placeholder icon when a product
  has none; used by the product card (`product-card.tsx:46-52`, shared by the listing
  and search results) and a new client-side `ProductGallery`
  (`[slug]/product-gallery.tsx`) with a thumbnail rail. `isUnoptimizedImageSrc`
  (`catalog.ts:282`) renders same-origin/root-relative sources (mock, seed)
  `unoptimized` so `sharp` is never hit in dev/CI; the LCP image (first card, PDP main
  image) uses Next 16's `preload`, not the deprecated `priority`.
- **Fix: image position could collide after delete-then-add** (#195, PR #198) —
  `image.repository.ts`'s `createImage` now computes the next slot as
  `max(position) + 1` rather than the row count, so deleting a non-last image and then
  adding a new one can no longer collide with a surviving row's position
  (`{0,1,2}` → delete `0` → the old count-based logic would reuse `2`; `max + 1`
  correctly yields `3`, a harmless gap instead of a duplicate).
- **Vercel Blob adapter + `remotePatterns` + operator setup** (#189, PR #199) —
  `VercelBlobStorageProvider` (`vercel-blob.ts:89-149`): `issueSignedToken` (a
  delegation scoped to exactly one pathname, `put` only, one content type, one size
  ceiling) → `presignUrl` (local HMAC, no network) → a deterministic public URL
  (`addRandomSuffix: false`, since `buildObjectKey` already guarantees uniqueness);
  `delete` forwards to `del()`, best-effort. `next.config.ts:18-20` adds
  `images.remotePatterns` for `*.public.blob.vercel-storage.com`.
  `docs/milestones/M5-product-images/vercel-blob-setup.md` documents the one-time
  operator setup plus a free smoke test.
- **Upload→render E2E + architecture/media docs** (#190, PR #200) —
  `e2e/product-images.spec.ts`: an admin uploads to the seeded, image-less `enamel-mug`
  product and the same image renders on both the storefront card and the PDP, driven
  against `pnpm build && pnpm start` with the mock provider
  (`playwright.config.ts`'s `webServer.env: { NODE_ENV: "test" }` — `next start` alone
  defaults to production and would 404 the local sink). Added `docs/ARCHITECTURE.md` §7
  Media + 2 decision-log entries, and the `docs/DATABASE.md` `ProductImage` section.
- **Handoff security fix: harden the `addImage` key gate** (#201, PR #202) —
  `src/server/storage/object-key.ts`'s `isSafeObjectKey` rejects any `/`-segment that is
  empty, `.`, `..`, or carries a `\`/NUL byte; `image.service.ts:151-157`'s `addImage`
  now gates on `startsWith(prefix) && isSafeObjectKey(key)`, not the prefix alone —
  closing the gap where `tenants/<me>/../<victim>/…` passed the old prefix-only check.
  Not exploitable in practice (object stores treat pathnames as opaque literals, so the
  security review scored real impact ~2/10), but it removed an unverified assumption
  about a third-party SDK's `del()` normalization and unified both providers behind one
  shared, traversal-free key invariant — the same lesson this repo already learned from
  the open-redirect saga (#103/#128): a prefix check alone is insufficient. Merged into
  `development` at milestone handoff.

## Exit criteria

All eight checklist items in `GOAL.md` — the source of truth, condensed below with
evidence.

- [x] **Admin CRUD on images** — upload (multi), reorder, caption, delete, all in the
      product form's edit mode, tenant-scoped, validated (type/size/count), storage
      credentials server-only, image bytes never through a Server Action — PR #196
      (#187): `product-image-manager.tsx`, `actions.ts` (5 actions, each
      `requireAdminContext`-gated); size/type caps re-checked in `image.service.ts:85-97`.
- [x] **Schema, migration-safe** — `ProductImage` (own `tenantId` + `key`) ships in one
      additive `CREATE TABLE`, no `ALTER TABLE`; `pnpm db:check-migrations` passes;
      existing (image-less) products render the placeholder unaffected — PR #192
      (#184): `prisma/schema.prisma:223-267`,
      `prisma/migrations/20260905195858_add_product_image/migration.sql`.
- [x] **`StorageProvider` seam** — an env-keyed selector (`BLOB_READ_WRITE_TOKEN`
      presence); the local-disk mock is the dev/test/CI default (no bucket/token
      needed); the real Vercel Blob adapter runs when the token is set;
      prod-with-no-token throws `StorageNotConfiguredError` at use, never at boot — PR
      #193 (#185): `storage/index.ts:46-54`, `storage.errors.ts`; PR #199 (#189):
      `storage/vercel-blob.ts`.
- [x] **Rendering everywhere** — the card, listing, search, and PDP gallery all render
      via `next/image` (`preload` for LCP, `unoptimized` for local/mock); a
      no-images product falls back to the placeholder; `remotePatterns` set for the
      Blob host; `alt` always present (caption or product title) — PR #197 (#188):
      `product-image.tsx:24-61`; PR #199 (#189): `next.config.ts:18-20`.
- [x] **Tenant-namespaced keys, gated writes** — every key is
      `tenants/<tenantId>/products/<productId>/<random>-<slug>.<ext>`
      (`buildObjectKey`); writes/deletes are admin + tenant gated; images are
      public-read (`BLOB_ACCESS = "public"`, `vercel-blob.ts:68`); delete removes the
      row then best-effort deletes the object (`image.service.ts:225-253`) — PR #194
      (#186), hardened by PR #202 (#201): `object-key.ts`'s `isSafeObjectKey` closes the
      interior-traversal gap a prefix-only check missed.
- [x] **Tenancy + layering intact** — Prisma only in `image.repository.ts`; all business
      rules in `image.service.ts`; no Prisma in pages/actions; image-bearing reads typed
      via standalone `Prisma.ProductGetPayload` (`product.repository.ts:52-54`,
      `product-card.tsx:9-11`), never `ReturnType<typeof …>` — verified by
      `pnpm typecheck` passing clean.
- [x] **Tests green in CI** — unit (`image.service.test.ts`, `object-key.test.ts`,
      `storage/{mock,index,local-path,vercel-blob}.test.ts`), integration
      (`image.repository.integration.test.ts` — tenant isolation, position math,
      the wired-includes order, real Postgres), E2E (`e2e/product-images.spec.ts`) —
      `verify` + `test-db` + `e2e` + CodeQL green on `development` at `9581ed7` (the
      PR #202 merge commit, GitHub Actions).
- [x] **Docs** — `research.md` + `GOAL.md` (produced at `/milestone-start`, PR #191),
      `docs/ARCHITECTURE.md` §7 Media + decision log (PR #200), `docs/DATABASE.md`'s
      `ProductImage` section, `vercel-blob-setup.md` (PR #199), this `handoff.md`.

## Key decisions

Also appended to the `docs/ARCHITECTURE.md` §9 decision log (two of the entries below;
see that file for the full text).

- **Vercel Blob, via its presigned-URL primitives, over Cloudflare R2** —
  `issueSignedToken` and `presignUrl` (the server-only `@vercel/blob` entry, not
  `/client`) are callable from a plain Server Action, so image writes stay on the repo's
  all-Server-Action mutation path with zero new route handlers and no webhook (Blob's
  `onUploadCompleted` never fires on localhost/CI). The app already deploys on Vercel
  (no new account/DNS), and the free tier has a hard, non-billing cap. R2 — the stronger
  portable-S3 CV signal — is documented as the runner-up behind the same seam
  (`docs/milestones/M5-product-images/research.md`), a one-adapter swap if ever wanted.
- **`StorageProvider` seam, mock-first** — mirrors the M4 `FulfillmentProvider` seam
  exactly: an interface, a selector keyed on secret presence, a deterministic mock as
  the CI/test default and dev fallback. Nothing above the boundary (admin manager,
  catalog reads, `next/image`) changes when the real bucket turns on.
- **`ProductImage` carries its own `tenantId`** — a deliberate divergence from
  `ProductVariant` (which has none and is scoped only through its product). Golden rule
  1 plus storage-key namespacing (`tenants/<tenantId>/products/<productId>/…`) make the
  tenant a first-class fact of the row, not something re-derived on every write.
- **Blur and server-side image processing deferred; render `unoptimized` for
  local/mock** — a CSS shimmer (`animate-pulse`) covers the loading state for v1, which
  keeps `sharp`/`plaiceholder` out of the dependency tree entirely; `blurDataUrl` is
  reserved on the model for a later pass. Same-origin/root-relative sources (the mock,
  seed images) render `unoptimized` so the `sharp`-requiring optimizer is never invoked
  in dev/CI; only real, remote Blob URLs are optimized (by Vercel's own infrastructure
  in production).
- **Handoff hardening: one shared traversal-free key invariant** (#201) — rather than
  patch `addImage`'s prefix check in isolation, `isSafeObjectKey` was added to
  `object-key.ts` — the same module that already shapes every key both providers mint —
  so the "no key may contain a traversal segment" rule lives in exactly one place,
  consumed by `addImage`'s tenant gate and (already, since #185) by the local mock's own
  filesystem resolver. A legitimately-minted key always satisfies it, so the change is
  purely additive.

## Known issues / tech debt

Two review passes ran at handoff. The built-in `security-review` skill's only finding
was the interior-traversal key gap above; it scored sub-threshold on real exploitability
(object stores treat a pathname as an opaque literal, not a filesystem path) but was
fixed anyway rather than deferred, because it touches a tenant-isolation invariant
(#201/PR #202). The `reviewer` agent's independent structural pass found the milestone
**ship-ready — no blockers**: tenant scoping, the atomic ownership gates, the
position-math invariant (#195's fix), and the layering (Prisma only in the repository,
business rules only in the service) all verified correct.

- **The local mock's upload sink has no per-request auth of its own** — like a real
  presigned URL, possession of the (random, unguessable) key path IS the credential;
  `PUT /api/uploads/local/[...key]` does not separately check a session. This exactly
  mirrors how a real Vercel Blob presigned URL works (whoever holds the URL may write to
  it, for its short validity window) and the route 404s outright in production
  (`env.NODE_ENV === "production"`), so it is **not a tenant-isolation gap** — it is the
  documented trust model of the feature, exercised only in dev/test.
- **Deferred by design** (from `GOAL.md`'s "Out of scope," none tracked as issues yet):
  variant-level images (`ProductVariant.imageId?`, the obvious fast-follow); server-side
  image processing / blur placeholders (`sharp`/`plaiceholder` — the `blurDataUrl`
  column is reserved for this); the `onUploadCompleted` webhook confirmation path (needs
  a public tunnel in dev/CI — the post-upload Server Action is the deliberate
  alternative; a rare orphaned object on a client-vanishes-mid-flow is accepted, and the
  namespaced keys make a future cleanup cron trivial); in-browser crop/edit, focal-point
  selection, video, bulk import, and AI-generated alt text.
- A concurrent double-upload can momentarily push a product's image count one or two
  over `MAX_IMAGES_PER_PRODUCT` (two signs can both observe a below-cap count before
  either persists) — documented in `image.service.ts:115-119` as an accepted soft-cap
  race, not a hard invariant, the same posture the repository already documents for the
  position-append race.

## How to run & verify

```bash
docker compose up -d                 # Postgres on host port 55432
pnpm install
cp .env.example .env
pnpm db:migrate
pnpm db:seed                         # seeds classic-tee (2 images) + everyday-hoodie (1)
pnpm dev                             # http://localhost:3000
```

`BLOB_READ_WRITE_TOKEN` is optional and unset by default — dev and CI run entirely
against the deterministic local-disk mock (bytes under `public/uploads/**`), no Vercel
account needed. To exercise the real adapter, follow
`docs/milestones/M5-product-images/vercel-blob-setup.md` (one-time operator setup: create
a public Blob store, generate a read-write token, set `BLOB_READ_WRITE_TOKEN`; the doc's
smoke test is free).

```bash
pnpm test                            # unit — no infra, seconds
pnpm test:integration                # needs `docker compose up -d` (Postgres on 55432)
pnpm build && pnpm test:e2e          # Playwright boots `pnpm start` itself (mock provider)
```

**Happy path** — M1–M4's flows (browse → cart → checkout → PAID; subdomains; search;
shopper accounts; fulfillment) are unchanged; see their handoffs. On top of it:

1. Sign in to the admin (`/admin/demo`, seeded admin account) and open **Products**.
   `classic-tee` and `everyday-hoodie` already show a thumbnail on the card;
   `enamel-mug` shows the placeholder icon.
2. Edit `enamel-mug` → the **Images** card (edit mode only) shows "No images yet."
   Upload a file: it appears as a thumbnail almost immediately (presign → direct PUT →
   persist). Reorder with the up/down controls, add a caption, then delete it — each
   change saves immediately, no page reload.
3. Visit the storefront `/products` and `/products/enamel-mug` — the uploaded image (or
   its absence, if you deleted it in step 2) renders identically to what the admin
   manager showed.
4. Search for a product on the storefront search page — results show the same card
   image as the listing.
5. A product with more than one image (`classic-tee`) shows a thumbnail rail on its PDP;
   clicking a thumbnail swaps the main image without a page reload.

## Inherited by next milestone

Real image storage is now live behind the `StorageProvider` seam (mock in dev/test,
Vercel Blob in production) — any future storage-facing need should implement the
interface and select it in `storage/index.ts`, never touch catalog/admin code directly.
The redesigned product card and the new PDP gallery are exactly the slots the paused
Claude Design UI-redesign track needs filled to resume (the PR #183 gallery placeholder
is now real). Seams and fast-follows left open on purpose — see Known issues above for
the full list:

- Variant-level images, server-side blur/processing, the `onUploadCompleted` webhook
  path, and richer editing (crop, focal point, bulk import, AI alt text) all remain
  deliberately deferred.
- The Claude Design UI-redesign track resumes now that its image dependency is filled.

## Links

- Release: **`vM5`** — pending (release PR `development` → `main` + tag cut at handoff).
- Milestone: GitHub Milestone "M5 — product-images" (#5) — 9/9 closed, 0 open.
- Review: `security-review` skill — one sub-threshold finding, fixed rather than
  deferred (#201/PR #202). `reviewer` agent structural pass — ship-ready, no blockers.
- Merged PRs: #191 (docs: M5 kickoff brief), #192 (closes #184), #193 (closes #185), #194
  (closes #186), #196 (closes #187), #197 (closes #188), #198 (closes #195), #199
  (closes #189), #200 (closes #190), #202 (closes #201 — handoff security fix).
- Closed issues (9, milestone-tagged): #184, #185, #186, #187, #188, #189, #190, #195,
  #201.
- Changeset: `vM4..development` — 22 commits, 60 files, +5,255 / −88
  (`git diff vM4..development --shortstat`).
