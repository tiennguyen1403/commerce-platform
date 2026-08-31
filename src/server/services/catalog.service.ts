import { productRepository } from "@/server/repositories/product.repository";

/**
 * Business logic for the storefront catalog. Kept thin for now — validation,
 * pricing rules, and inventory checks land here as Phase 1 fills out.
 */
export const catalogService = {
  getStorefrontProducts(tenantId: string) {
    return productRepository.listActiveByTenant(tenantId);
  },

  getProductBySlug(tenantId: string, slug: string) {
    return productRepository.findBySlug(tenantId, slug);
  },
};
