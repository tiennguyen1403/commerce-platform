import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { tenantRepository } from "@/server/repositories/tenant.repository";
import { DEMO_TENANT_SLUG } from "@/config/constants";

export interface StoreContext {
  tenantId: string;
  tenantName: string;
  /** The store's single currency (lowercase ISO 4217). Every price shown and
   *  every total charged is in this currency; the catalog has no other. */
  currency: string;
}

/**
 * Resolve the active storefront tenant, once per request.
 *
 * M1 is single-tenant: the public store always renders the seeded `demo`
 * tenant (per-tenant subdomains arrive in M3). This mirrors the admin's
 * `requireAdminContext` but without the auth gate — the storefront is public.
 * `cache()` dedupes the lookup so the layout and every child page share a
 * single query per request. A missing tenant means the app was never seeded,
 * so there is no store to show: `notFound()`.
 */
export const getStoreTenant = cache(async (): Promise<StoreContext> => {
  const tenant = await tenantRepository.findBySlug(DEMO_TENANT_SLUG);
  if (!tenant) notFound();
  return {
    tenantId: tenant.id,
    tenantName: tenant.name,
    currency: tenant.currency,
  };
});
