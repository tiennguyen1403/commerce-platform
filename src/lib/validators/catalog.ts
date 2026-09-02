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
