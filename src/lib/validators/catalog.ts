import { z } from "zod";

/**
 * Catalog input schemas — the single source of truth for product/variant
 * shape, shared by the client form (UX validation) and the Server Actions
 * (authoritative validation). Pure zod only: this file is imported by client
 * components, so it must never pull in `server-only` modules.
 *
 * Money is integer minor units (`priceCents`) everywhere — the dollar⇄cents
 * conversion happens at the form edge, never in stored/validated data.
 */

export const PRODUCT_STATUSES = ["DRAFT", "ACTIVE", "ARCHIVED"] as const;
export type ProductStatusValue = (typeof PRODUCT_STATUSES)[number];

export const STATUS_LABELS: Record<ProductStatusValue, string> = {
  DRAFT: "Draft",
  ACTIVE: "Active",
  ARCHIVED: "Archived",
};

// Supported store currencies (`Tenant.currency`). Lowercase ISO 4217 to match
// Stripe's convention. A store picks one; variants inherit it.
export const CURRENCIES = ["usd", "eur", "gbp"] as const;
export type CurrencyValue = (typeof CURRENCIES)[number];

export const CURRENCY_LABELS: Record<CurrencyValue, string> = {
  usd: "USD",
  eur: "EUR",
  gbp: "GBP",
};

// Lowercase words joined by single hyphens, e.g. "classic-tee". Exported and
// reused by store-slug (subdomain) onboarding validation — one shape rule for
// every user-facing slug in the app, never redefined.
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Ceilings that keep an obviously-bad value (a typo, a tampered payload) out of
// the database without getting in a real admin's way. $1,000,000 max price.
const MAX_PRICE_CENTS = 100_000_000;
const MAX_STOCK = 1_000_000;

export const variantInputSchema = z.object({
  // Present on variants that already exist (edit); absent for newly added rows.
  id: z.string().min(1).optional(),
  sku: z
    .string()
    .trim()
    .min(1, { error: "SKU is required." })
    .max(64, { error: "SKU is too long." }),
  name: z
    .string()
    .trim()
    .min(1, { error: "Variant name is required." })
    .max(120, { error: "Variant name is too long." }),
  priceCents: z
    .int({ error: "Enter a valid price." })
    .min(0, { error: "Price can't be negative." })
    .max(MAX_PRICE_CENTS, { error: "Price is too high." }),
  // No per-variant currency: the price is always in the store's currency
  // (`Tenant.currency`). That's what keeps a cart/order single-currency and
  // soundly summable — enforced at the data model, not just here.
  stock: z
    .int({ error: "Enter a whole number." })
    .min(0, { error: "Stock can't be negative." })
    .max(MAX_STOCK, { error: "Stock is too high." }),
  // Optional mapping to the fulfillment provider's opaque catalog variant id
  // (e.g. Printful's integer `variant_id`); the submission service resolves our
  // free-form `sku` → `providerVariantId` via the repository (M4). Kept
  // provider-agnostic — free-form text, trimmed and length-capped like `sku`.
  // Blank is valid: an unmapped variant is a defined, admin-visible state (it
  // fails submission loudly in M4-06, never a silent provider 4xx), not an
  // error here. Output stays `string | undefined` (never `null`) so the schema
  // is idempotent — the Server Action re-parses the client's parsed payload.
  providerVariantId: z
    .string()
    .trim()
    .max(64, { error: "Provider variant ID is too long." })
    .optional(),
});

export type VariantInput = z.infer<typeof variantInputSchema>;

export const productInputSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, { error: "Title is required." })
    .max(160, { error: "Title is too long." }),
  slug: z
    .string()
    .trim()
    .min(1, { error: "Slug is required." })
    .max(160, { error: "Slug is too long." })
    .regex(SLUG_PATTERN, {
      error: "Use lowercase letters, numbers, and hyphens only.",
    }),
  description: z
    .string()
    .trim()
    .max(2000, { error: "Description is too long." })
    .optional(),
  status: z.enum(PRODUCT_STATUSES, { error: "Choose a status." }),
  variants: z
    .array(variantInputSchema)
    .min(1, { error: "Add at least one variant." })
    .refine(
      (variants) => {
        const skus = variants.map((v) => v.sku.trim().toLowerCase());
        return new Set(skus).size === skus.length;
      },
      { error: "Each variant needs a unique SKU." },
    ),
});

export type ProductInput = z.infer<typeof productInputSchema>;

/** Field-keyed messages surfaced back to the form (e.g. `{ slug: "…" }`). */
export type FieldErrors = Record<string, string>;

/** Discriminated result every catalog Server Action returns to the client. */
export type ActionResult =
  | { ok: true; id: string }
  | { ok: false; formError?: string; fieldErrors?: FieldErrors };

// --- Storefront search (#106) ------------------------------------------------

/** Max length for a storefront search query. Long enough for any real phrase,
 *  short enough to keep a tampered/pathological `?q` out of the tsquery path —
 *  the repository imposes no cap of its own, so this is the only one. */
const MAX_SEARCH_QUERY_LENGTH = 100;

/**
 * Parse the storefront catalog-search URL params (#106). Forgiving like the
 * order-list schemas: an absent/whitespace `q` collapses to "" (the empty-query
 * prompt), a non-string or mistyped `?page` falls back to 1 — a fiddled query
 * string should render a clean view, never error a page a shopper is browsing.
 * `q` is trimmed and length-capped here (the only cap downstream); `pageSize` is
 * a server constant, not user input, so it isn't parsed.
 */
export const searchProductsParamsSchema = z.object({
  q: z
    .string()
    .catch("")
    .transform((value) => value.trim().slice(0, MAX_SEARCH_QUERY_LENGTH)),
  page: z.coerce.number().int().positive().catch(1),
});

export type SearchProductsParamsInput = z.infer<
  typeof searchProductsParamsSchema
>;

// --- Image uploads (#185, M5) ------------------------------------------------

/**
 * Content types a product image may be uploaded as. Business-rule allowlist (like
 * `MAX_PRICE_CENTS`/`MAX_STOCK` above) — a constant, deliberately NOT env: it
 * shapes validation, not deployment. Shared by the upload form (pre-check the
 * picked file) and the sign step (authoritative re-check) — one list, both sides.
 * JPEG/PNG/WebP cover what a browser file picker reliably produces; HEIC/AVIF are
 * omitted (patchy browser support, and v1 does no transcode — no `sharp`).
 */
export const ALLOWED_IMAGE_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export type AllowedImageContentType =
  (typeof ALLOWED_IMAGE_CONTENT_TYPES)[number];

/**
 * The stored file extension per allowed content type — one source of truth for the
 * "which image formats" fact. `satisfies` keeps it exhaustive (adding a content type
 * to the allowlist without an extension here fails to compile). Consumers: the
 * storage mock derives an object's extension from its content type, and the local
 * upload sink allows exactly these extensions to be written (so a direct caller
 * can't drop a `.html` into the web-served uploads dir).
 */
export const IMAGE_CONTENT_TYPE_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} satisfies Record<AllowedImageContentType, string>;

/**
 * Hard ceiling on a single uploaded product image, in bytes (5 MB). Enforced at
 * sign time (server, authoritative) and mirrored by the local sink as defence in
 * depth. Generous for a web product photo, small enough to keep a tampered/runaway
 * upload off the storage bill — the analogue of `MAX_PRICE_CENTS` for uploads.
 */
export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * Max images one product may hold. The gallery is a small hero + thumbnails, so
 * this is a UX/cost guard, not a technical limit; the create/count-cap service
 * enforces it and the admin form surfaces it.
 */
export const MAX_IMAGES_PER_PRODUCT = 8;

/**
 * Max length of an image's alt text (caption). Generous for a real caption yet
 * capped so a tampered payload can't store an unbounded string. A business-rule
 * constant like the price/stock ceilings — the single source of truth shared by
 * the admin form (client pre-check) and the Server Action (authoritative parse).
 */
export const IMAGE_ALT_TEXT_MAX = 300;

/**
 * A single stored/rendered image, serialized for the client. The admin image
 * manager and (later, M5-05) the storefront read it; a plain type — never a
 * Prisma import — so it stays client-safe. `altText`/`width`/`height` are nullable
 * (alt text is admin-entered, dims are client-measured and may be absent).
 */
export type ProductImageDto = {
  id: string;
  url: string;
  key: string;
  altText: string | null;
  width: number | null;
  height: number | null;
  position: number;
};

/**
 * Is `url` safe to persist and later render as an `<img src>` on the public
 * storefront? The `url` is client-supplied in the persist step (the browser echoes
 * back the `publicUrl` the sign step minted), so the boundary re-checks it rather
 * than trusting it. Allows exactly the two shapes a provider mints — a root-relative
 * path (`/uploads/…`, the local mock) or a well-formed absolute `https://` URL
 * (Vercel Blob) — and rejects everything else: `javascript:`/`data:` schemes, plain
 * `http:`, and any form that resolves to an external origin.
 *
 * A deliberately narrow allowlist, and — the lesson of the repeated `?redirect=`
 * open-redirect fixes (#99 → #103 → #128) — NOT a naive `startsWith("/")` prefix
 * test: browsers strip TAB/LF/CR from a URL and treat `\` as `/` before resolving,
 * so `"/\evil.com"` or `"/<TAB>/evil.com"` would sail past a `/`-prefix check yet
 * load from `//evil.com`. So we reject those characters outright, then parse (not
 * prefix-test) the absolute form and require a single-slash root-relative otherwise.
 */
export function isSafeImageUrl(url: string): boolean {
  // Control chars (incl. TAB U+0009 / LF / CR / NUL) and backslashes first: an
  // interior one can smuggle a `//host` past the root-relative branch below.
  if (/[\x00-\x1f\x7f\\]/.test(url)) return false;

  // Absolute form → must be a well-formed https URL. Parsing, not a prefix test, so
  // a malformed authority can't slip through.
  if (/^https:\/\//i.test(url)) {
    try {
      return new URL(url).protocol === "https:";
    } catch {
      return false;
    }
  }

  // Otherwise the only accepted form is a root-relative path — a single leading
  // slash (the mock's `/uploads/…`), never `//host`. With control chars and
  // backslashes already rejected, this can no longer resolve off-origin.
  return url.startsWith("/") && !url.startsWith("//");
}

/**
 * The alt-text (caption) field, shared by the add and update image schemas. Trims,
 * length-caps, and collapses a blank/whitespace-only value to `undefined` (never
 * `""`, never `null`) — so "no caption" is one canonical value from the validation
 * boundary onward, and the schema stays idempotent (re-parsing its own output is a
 * fixed point) for the double-parse convention.
 */
const imageAltTextField = z
  .string()
  .trim()
  .max(IMAGE_ALT_TEXT_MAX)
  .transform((value) => (value === "" ? undefined : value))
  .optional();

/**
 * Payload for the sign step (`getImageUploadUrlAction`). Shape-guards the request
 * — present, typed, bounded — before it reaches the service; the authoritative
 * content-type-allowlist and size-cap checks (with their friendly, limit-aware
 * messages) live in `imageService.requestUpload`, so they are deliberately NOT
 * duplicated here.
 */
export const imageUploadRequestSchema = z.object({
  contentType: z.string().trim().min(1).max(100),
  fileName: z.string().trim().min(1).max(200),
  sizeBytes: z.int().min(0),
});

export type ImageUploadRequestInput = z.infer<typeof imageUploadRequestSchema>;

/**
 * Payload for the persist step (`addProductImageAction`), sent after the browser's
 * direct PUT succeeds. Idempotent like the catalog schemas — `altText` outputs
 * `string | undefined`, never `null` — so the Server Action can safely re-parse the
 * client's already-parsed data (the double-parse convention). `width`/`height` are
 * the client-measured intrinsic dimensions (omitted when the browser couldn't
 * decode them). `url` is allowlist-checked; `key` is stored opaque.
 */
export const addImageSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine(isSafeImageUrl, { error: "Unsupported image URL." }),
  key: z.string().trim().min(1).max(1024),
  altText: imageAltTextField,
  width: z.int().positive().max(50_000).optional(),
  height: z.int().positive().max(50_000).optional(),
});

export type AddImageInputParsed = z.infer<typeof addImageSchema>;

/**
 * Payload for `reorderProductImagesAction`: the full set of the product's image
 * ids in their new order. The service authoritatively checks it's a permutation of
 * the product's current images; this only shape-bounds it (a generous sanity cap,
 * not the soft per-product limit, so a legitimately over-cap product — the
 * documented append race — can still be reordered).
 */
export const reorderImagesSchema = z.object({
  orderedIds: z.array(z.string().min(1)).min(1).max(100),
});

/**
 * Payload for `updateImageAltTextAction`. Idempotent (`altText` → `string |
 * undefined`, a blank caption collapsing to `undefined`), so the action re-parses
 * safely; the service then persists `undefined` as `null` to clear the caption.
 */
export const updateImageAltTextSchema = z.object({
  imageId: z.string().min(1),
  altText: imageAltTextField,
});

/** Shared failure shape for the image actions — a single inline message the
 *  manager surfaces (near the uploader or the affected image), rather than the
 *  field-keyed errors the product form uses. */
export type ImageActionError = { ok: false; error: string };

/** `getImageUploadUrlAction` success carries the direct-PUT target plus the
 *  `publicUrl`/`key` the client echoes back to the persist step. */
export type SignUploadResult =
  | { ok: true; uploadUrl: string; publicUrl: string; key: string }
  | ImageActionError;

/** `addProductImageAction` success returns the created row so the manager can
 *  render it without a full refetch. */
export type AddImageResult =
  { ok: true; image: ProductImageDto } | ImageActionError;

/** Reorder / alt-text / delete: the client already holds the resulting state, so
 *  success needs no payload. */
export type ImageMutationResult = { ok: true } | ImageActionError;
