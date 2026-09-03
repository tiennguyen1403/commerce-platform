import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { tenantRepository } from "@/server/repositories/tenant.repository";
import { TENANT_SLUG_HEADER } from "@/config/constants";

export interface StoreContext {
  tenantId: string;
  tenantName: string;
  /** The store's single currency (lowercase ISO 4217). Every price shown and
   *  every total charged is in this currency; the catalog has no other. */
  currency: string;
  /** OKLCH hue angle for this store's accent (see `src/lib/theme.ts`). Raw from
   *  the DB; validated at the CSS-injection boundary (`tenantThemeCss`), which
   *  falls back to the default for an out-of-range value. */
  themeHue: number;
}

/**
 * Resolve the active storefront tenant, once per request.
 *
 * The tenant is chosen by the request host: the proxy (`src/proxy.ts`) parses
 * `{slug}.{app-domain}` and injects a trusted `x-tenant-slug`, which we read
 * here via `headers()`. The proxy deletes any inbound value first, so this slug
 * is host-derived and unforgeable — never trust `x-tenant-slug` outside this
 * proxy → header → `getStoreTenant` path. A missing header (the apex host, a
 * reserved subdomain) or an unknown slug means there's no store to show:
 * `notFound()`. `cache()` dedupes the lookup so the layout and every child page
 * share a single query per request. Reading `headers()` also makes every
 * storefront route dynamic, which is correct — the catalog is per-tenant.
 */
export const getStoreTenant = cache(async (): Promise<StoreContext> => {
  const slug = (await headers()).get(TENANT_SLUG_HEADER);
  if (!slug) notFound();

  const tenant = await tenantRepository.findBySlug(slug);
  if (!tenant) notFound();

  return {
    tenantId: tenant.id,
    tenantName: tenant.name,
    currency: tenant.currency,
    themeHue: tenant.themeHue,
  };
});
