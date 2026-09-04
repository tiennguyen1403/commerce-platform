import { z } from "zod";

/**
 * Checkout input shape, shared by the client form (UX validation) and the
 * Server Action (authoritative validation). Pure zod, no `server-only` import,
 * so both sides use the exact same rules. The cart itself is never sent from the
 * client — it's read from the cookie and re-priced server-side — so the only
 * fields the shopper supplies here are their email and shipping address.
 */

// Countries we ship to (`Order.shipCountry`). ISO-3166 alpha-2 to match the
// `ShippingAddress` domain shape and every fulfillment provider's convention.
// Mirrors the `CURRENCIES` allowlist pattern (`catalog.ts`): a `[...] as const`
// tuple feeding a `z.enum`, so adding a country is a one-line change here and the
// checkout form's country picker (which maps over this list) extends for free.
// **US-only to start** — an easy, deliberate fast-follow to widen once we validate
// per-country address rules (see the country-scoped checks in the schema below).
export const SHIPPING_COUNTRIES = ["US"] as const;
export type ShippingCountry = (typeof SHIPPING_COUNTRIES)[number];

export const SHIPPING_COUNTRY_LABELS: Record<ShippingCountry, string> = {
  US: "United States",
};

// US ZIP: five digits, optionally the +4 add-on (e.g. 94103 or 94103-1234). The
// only country-specific postal rule today; when SHIPPING_COUNTRIES widens, add a
// sibling pattern rather than loosening this one.
const US_ZIP_PATTERN = /^\d{5}(-\d{4})?$/;

/**
 * A shipping destination collected at checkout. Field names mirror the
 * `ShippingAddress` domain interface (`src/server/fulfillment/provider.ts`) so a
 * parsed value threads straight through to persistence and, later, the
 * fulfillment provider. Required fields are trimmed and non-empty; `line2` and
 * `state` are optional in the base shape ("requiredness varies by country"), then
 * tightened per-country below — for the US, a state and a valid ZIP are required.
 * Caps keep a tampered/pathological payload out of the DB without crowding a real
 * address (mirrors the catalog validators' ceilings).
 */
export const shippingAddressSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, { error: "Enter the recipient's full name." })
      .max(120, { error: "Name is too long." }),
    line1: z
      .string()
      .trim()
      .min(1, { error: "Enter a street address." })
      .max(200, { error: "Address is too long." }),
    line2: z
      .string()
      .trim()
      .max(200, { error: "Address is too long." })
      .optional(),
    city: z
      .string()
      .trim()
      .min(1, { error: "Enter a city." })
      .max(120, { error: "City is too long." }),
    state: z
      .string()
      .trim()
      .max(120, { error: "State is too long." })
      .optional(),
    postalCode: z
      .string()
      .trim()
      .min(1, { error: "Enter a postal code." })
      .max(20, { error: "Postal code is too long." }),
    country: z.enum(SHIPPING_COUNTRIES, {
      error: "Choose a country we ship to.",
    }),
  })
  // A US address needs a state — enforced here (not in the base shape) so
  // widening `SHIPPING_COUNTRIES` to a state-less country doesn't wrongly require
  // one. Path-scoped so the message lands on the state field in the form.
  .refine((a) => a.country !== "US" || (a.state?.trim().length ?? 0) > 0, {
    error: "Enter a state.",
    path: ["state"],
  })
  // A US ZIP must be well-formed — a cheap guard against a typo shipping the order
  // nowhere. Same country-scoped structure as the state rule.
  .refine((a) => a.country !== "US" || US_ZIP_PATTERN.test(a.postalCode), {
    error: "Enter a valid US ZIP code (e.g. 94103).",
    path: ["postalCode"],
  });

export type ShippingAddressInput = z.infer<typeof shippingAddressSchema>;

export const checkoutInputSchema = z.object({
  // 254 is the practical RFC-5321 ceiling for a full email address.
  email: z.email({ error: "Enter a valid email address." }).max(254),
  shippingAddress: shippingAddressSchema,
});

export type CheckoutInput = z.infer<typeof checkoutInputSchema>;
