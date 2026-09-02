import { z } from "zod";
import { CURRENCIES } from "@/lib/validators/catalog";

/**
 * Store-settings input shapes + result types, shared by the client settings
 * form (UX validation) and the Server Action (authoritative validation). Pure
 * zod + plain data: imported by a client component, so it must never pull in a
 * `server-only` module. The supported set is `CURRENCIES` from the catalog
 * validators — the single source of truth a store's currency is picked from.
 */

export const updateCurrencySchema = z.object({
  currency: z.enum(CURRENCIES, { error: "Choose a supported currency." }),
});
export type UpdateCurrencyInput = z.infer<typeof updateCurrencySchema>;

/** Field-keyed messages surfaced back to the settings form. */
export type SettingsFieldErrors = { currency?: string };

/** Discriminated result the settings Server Actions return to the client. */
export type SettingsActionResult =
  | { ok: true }
  | { ok: false; formError?: string; fieldErrors?: SettingsFieldErrors };
