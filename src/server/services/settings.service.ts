import "server-only";
import { tenantRepository } from "@/server/repositories/tenant.repository";
import type { CurrencyValue } from "@/lib/validators/catalog";

/**
 * Store-level settings: the store's currency, display name, and storefront
 * accent. Each method is a thin, deliberate delegate — shape validation (the
 * supported-currency set, the name's trim/length, the hue's 0–359 range) happens
 * at the Server Action boundary, so this layer trusts its typed input and stays
 * free of Prisma.
 *
 * Currency is the one with a subtlety worth stating: changing it only *re-labels*
 * existing prices — it does NOT convert `priceCents` (usd→eur reinterprets `1999`
 * as €19.99, not a converted amount), and it deliberately leaves `Order.currency`
 * snapshots untouched so historical totals stay correct. Actual price migration
 * is a separate, explicit step; this service is the seam where that would be
 * coordinated. The name and accent are plain, reversible attribute writes.
 */
export const settingsService = {
  /** Set the store's single currency. The caller (action) has already validated
   *  `currency` against the supported set and re-resolved the tenant from the
   *  session, so both are trusted here. */
  updateStoreCurrency(tenantId: string, currency: CurrencyValue) {
    return tenantRepository.updateCurrency(tenantId, currency);
  },

  /** Rename the store. The caller (action) has validated `name` (trim/length)
   *  and re-resolved the tenant from the session, so both are trusted here. */
  updateStoreName(tenantId: string, name: string) {
    return tenantRepository.updateName(tenantId, name);
  },

  /** Set the store's storefront accent hue. The caller (action) has validated
   *  `themeHue` (integer 0–359) and re-resolved the tenant from the session. The
   *  hue only re-tints the storefront accent tokens (see `src/lib/theme.ts`);
   *  nothing else about the catalog or orders changes. */
  updateStoreTheme(tenantId: string, themeHue: number) {
    return tenantRepository.updateThemeHue(tenantId, themeHue);
  },
};
