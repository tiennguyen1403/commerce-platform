import { z } from "zod";
import { CURRENCIES } from "@/lib/validators/catalog";
import { storeNameSchema } from "@/lib/validators/tenant";
import { themeHueSchema } from "@/lib/theme";

/**
 * Store-settings input shapes + result types, shared by the client settings
 * forms (UX validation) and the Server Actions (authoritative validation). Pure
 * zod + plain data: imported by client components, so it must never pull in a
 * `server-only` module. Each shape reuses the one canonical rule for its field —
 * `CURRENCIES` (catalog), `storeNameSchema` (tenant onboarding), and
 * `themeHueSchema` (the storefront theming boundary) — so settings can never
 * validate a value more loosely than the place that first defined it.
 */

export const updateCurrencySchema = z.object({
  currency: z.enum(CURRENCIES, { error: "Choose a supported currency." }),
});
export type UpdateCurrencyInput = z.infer<typeof updateCurrencySchema>;

/** Rename the store. Same trim/length rule the store was created under. */
export const updateNameSchema = z.object({ name: storeNameSchema });
export type UpdateNameInput = z.infer<typeof updateNameSchema>;

/** Set the storefront accent. `themeHue` is the OKLCH-hue boundary schema
 *  (integer 0–359) the storefront `<style>` is built from, so an out-of-range
 *  hue is refused here instead of falling back silently at render time. */
export const updateThemeSchema = z.object({ themeHue: themeHueSchema });
export type UpdateThemeInput = z.infer<typeof updateThemeSchema>;

/** Field-keyed messages surfaced back to the settings forms. */
export type SettingsFieldErrors = {
  currency?: string;
  name?: string;
  themeHue?: string;
};

/** Discriminated result the settings Server Actions return to the client. */
export type SettingsActionResult =
  | { ok: true }
  | { ok: false; formError?: string; fieldErrors?: SettingsFieldErrors };
