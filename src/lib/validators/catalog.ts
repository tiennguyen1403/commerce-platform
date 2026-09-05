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
