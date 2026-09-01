import { tenantRepository } from "@/server/repositories/tenant.repository";
import type { CurrencyValue } from "@/lib/validators/catalog";

/**
 * Store-level settings. For now that's the store's single currency
 * (`Tenant.currency`) — every variant price and order total inherits it.
 *
 * Changing the currency only *re-labels* existing prices: it does NOT convert
 * `priceCents` (usd→eur reinterprets `1999` as €19.99, not a converted amount),
 * and it deliberately leaves `Order.currency` snapshots untouched so historical
 * totals stay correct. Actual price migration is a separate, explicit step;
 * this service is the seam where that would be coordinated. Shape validation
 * (the supported-currency set) happens at the Server Action boundary, so this
 * layer trusts its typed input and stays free of Prisma.
 */
export const settingsService = {
  /** Set the store's single currency. The caller (action) has already validated
   *  `currency` against the supported set and re-resolved the tenant from the
   *  session, so both are trusted here. */
  updateStoreCurrency(tenantId: string, currency: CurrencyValue) {
    return tenantRepository.updateCurrency(tenantId, currency);
  },
};
