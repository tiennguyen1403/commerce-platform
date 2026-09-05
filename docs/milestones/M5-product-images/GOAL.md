# M5 — Product images

Products have **no images today** — every storefront surface (product card, listing, search, and
the PDP) renders a muted placeholder icon. That single gap is the biggest reason the UI reads as
"functional, not premium": a storefront lives on its photography. This milestone gives products
real images and renders them everywhere, filling the gallery + card slots the parallel **Claude
Design** UI-redesign track builds (the PDP gallery placeholder shipped in PR #183 is the slot to
wire up). It is a **data/feature** milestone — the counterpart to the UI-only redesign track.

Scope was fixed at `/milestone-start` (this doc). Technical decisions — the storage provider, the
upload flow, the schema shape, the provider seam, and dims/blur handling — are recorded in
[`research.md`](research.md), produced alongside this file. The M1–M4 rules are non-negotiable:
tenant-isolated, layered (UI/route → service → repository → Prisma), money stays integer **cents**,
server-only stays server-only.

## Goal

An admin uploads, orders, captions, and deletes **product images** in the existing product form
(tenant-scoped, validated); the storefront renders them through `next/image` on the product card,
listing, search, and a real **PDP gallery**; a product with no images falls back cleanly to
today's placeholder. Tenant-isolated, layered, server-only storage credentials.

## Key decisions (from research — see [`research.md`](research.md))

- **Storage provider: Vercel Blob**, via its **presigned-URL** primitives (`issueSignedToken` +
  `presignUrl`, server-only `@vercel/blob`) called from a **Server Action** gated by
  `requireAdminContext`. Lowest friction for a Vercel-deployed app; free tier is hard-capped (no
  overage bill, no inactivity pause); needs **zero new Route Handlers, no webhook, no ngrok**.
  Credentials (`BLOB_READ_WRITE_TOKEN`) are **server-only** (`env.ts`, `optionalEnvString`
  pattern), never `NEXT_PUBLIC_*`. **Cloudflare R2** is the documented runner-up behind the same
  seam. The image _files_ live in object storage, never the DB.
- **Storage seam (mirrors the M4 fulfillment provider seam)** — a `StorageProvider` interface
  (`getUploadUrl`/`delete`/`publicUrl`) + an env-keyed selector + a **deterministic local-disk
  mock as the dev/test/CI default** (writes under `public/uploads/**`, served `unoptimized`), so
  CI needs no real bucket or token and swapping providers is a one-adapter change.
- **Schema — a new `ProductImage` model** (one-to-many off `Product`): `id`, `tenantId`,
  `productId`, `url`, `key` (provider-opaque, for clean deletes + portability), `altText?`,
  `position` (ordering), `width?`/`height?` (captured client-side — required for a remote
  `next/image`), `blurDataUrl?` (reserved; unused in v1), `createdAt`/`updatedAt`. `ProductImage`
  carries its **own `tenantId`** (Golden Rule 1 + storage-key namespacing) — a deliberate
  divergence from `ProductVariant` (which has none). Additive, migration-safe: a **wholly new
  table**, so existing products simply have zero rows → placeholder.
- **Upload flow** — admin picks files (edit mode only — a create-mode product has no `productId`
  yet for the storage key) → client reads dims → a Server Action (admin + tenant gated; validates
  content-type `image/jpeg|png|webp`, a size cap, a per-product count cap) mints a presigned PUT
  URL for key `tenants/<tenantId>/products/<productId>/<id>` → the browser PUTs the file directly
  to storage → a second Server Action persists the `ProductImage` row. Reorder = rewrite
  `position`; delete = remove row + best-effort delete the object.
- **Tenant isolation** — storage keys namespaced `tenants/<tenantId>/products/<productId>/<id>`;
  images are **public-read** (the storefront needs them) but every **write/delete** is admin-gated
  and tenant-scoped; `ProductImage` rows carry `tenantId` like every business table.
- **Rendering** — swap the placeholder `ImageIcon` for **`next/image`** (responsive, lazy);
  `preload` (not the Next-16-deprecated `priority`) for LCP images; `unoptimized` for local/mock
  paths (keeps CI `sharp`-free); add the Blob host to `next.config.ts` `images.remotePatterns`.
  `alt = altText ?? title`. First image on the card; the ordered set in the PDP gallery.
  **Blur is deferred** to a CSS shimmer (the existing `animate-pulse` idiom) — this keeps `sharp`
  out of the dependency tree for v1.

## In scope

- `ProductImage` model + one additive, migration-safe migration; a few committed demo images in
  the seed so the storefront looks rich in dev and after deploy.
- The `StorageProvider` seam + local-disk mock + the real Vercel Blob adapter + `BLOB_READ_WRITE_TOKEN`
  config (optional, server-only).
- Admin: upload (multi), reorder, set alt text, delete — in the existing product form (edit mode),
  tenant-scoped, validated (type/size/count), server-only storage creds.
- Storefront rendering via `next/image`: product **card**, **listing**, **search**, and a real
  **PDP gallery** (main + thumbnail rail) — with a graceful **placeholder fallback** for
  image-less products (back-compat: every existing product).

## Out of scope (defer)

- **Variant-level images** (switch image on variant select) — the obvious fast-follow
  (`ProductVariant.imageId?`).
- **Blur placeholders / server-side image processing** (`sharp`/`plaiceholder`) — a CSS shimmer
  covers v1; the `blurDataUrl` column is reserved for a later pass.
- **The `onUploadCompleted` webhook** confirmation path (needs a tunnel in dev/CI) — persist via
  the post-upload Server Action instead; accept the rare orphaned object (namespaced keys make a
  future cleanup cron trivial).
- In-browser crop/edit, filters, focal-point selection; video; external CDN transforms beyond
  `next/image`; bulk import; AI-generated alt text.
- Re-theming the Stripe/checkout surfaces (that's the Claude Design UI track, separate).

## Exit criteria

_Finalized at `/milestone-start`. Adjust only with a note here if building forces a change._

- [ ] An admin uploads, reorders, captions, and deletes product images in the product form (edit
      mode); tenant-scoped; validated (type/size/count); storage credentials server-only, never
      `NEXT_PUBLIC_*`; image bytes never pass through a Server Action (client PUTs a presigned URL).
- [ ] `ProductImage` (with its own `tenantId` + a `key`) ships in one additive, migration-safe
      change; `pnpm db:check-migrations` passes; existing (image-less) products are unaffected.
- [ ] A `StorageProvider` seam with an env-keyed selector: a **local-disk mock is the dev/test/CI
      default** (no bucket/token needed), the real **Vercel Blob** adapter runs when
      `BLOB_READ_WRITE_TOKEN` is set, and prod-with-no-token throws a typed
      `StorageNotConfiguredError` at use (never at boot).
- [ ] The card, listing, search, and PDP gallery render images via `next/image` (`preload` for
      LCP, `unoptimized` for local/mock); a product with no images falls back to the placeholder;
      `remotePatterns` set for the Blob host; `alt` present.
- [ ] Storage keys namespaced by `tenantId`; writes/deletes admin + tenant gated; no cross-tenant
      read/write; images public-read; delete removes the row + best-effort deletes the object.
- [ ] Tenancy + layering intact (Prisma only in repositories; upload orchestrated in a service; no
      Prisma in pages; new field schemas idempotent for the admin form's double-parse;
      image-bearing read types are standalone `Prisma.*GetPayload`, never `ReturnType<typeof …>`).
- [ ] Tests: service/repository unit + integration (tenant-scoped upload/reorder/delete against
      the mock) + an E2E (upload in admin → image renders on the storefront, mock provider only).
      `verify` + `test-db` + `e2e` CI jobs green; no real bucket/`sharp` needed in CI.
- [ ] Docs: `docs/ARCHITECTURE.md` (a media section + decision-log entry), `docs/DATABASE.md` (the
      new table), the **Vercel Blob operator prerequisite** (store/token setup), `research.md`,
      `handoff.md`.

## Dependencies / sequencing

- **Feeds the Claude Design UI track.** The redesigned product card and the PDP gallery slot
  (the PR #183 placeholder frame at `src/app/(storefront)/products/[slug]/page.tsx`) are built to
  accept real images — this milestone fills them. The UI redesign resumes after M5.
- Build order (each ≈ one PR): schema → storage seam+mock → repository+service → (admin UI ∥
  storefront rendering) → real Blob adapter+setup → E2E+architecture docs. See the milestone
  description on GitHub.
- No dependency on M4 fulfillment beyond the shared product/tenant models.

## GitHub

- Milestone: **M5 — product-images** (#5).
- Issues labelled `phase:M5`, `type:*`, and `area:*` (`area:media` is new for the storage/image
  seam; plus `area:db`/`area:ui`/`area:ops`/`area:tests` as relevant); each ≈ one PR.
