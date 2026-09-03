import "server-only";
import { productRepository } from "@/server/repositories/product.repository";
import type { SearchProductsParams } from "@/server/repositories/product.repository";
import type { ProductInput } from "@/lib/validators/catalog";
import { ProductNotFoundError, SlugTakenError } from "@/server/catalog.errors";

/**
 * Business logic for the catalog — storefront reads plus the admin write path
 * (uniqueness rules, typed errors). Shape validation (zod) happens at the
 * Server Action boundary; unique-constraint failures are translated to typed
 * errors in the repository. This layer owns the business rules and the friendly
 * pre-checks, and stays free of Prisma.
 */

// Re-export so the Server Action boundary imports every catalog error from one
// place, without reaching into the repository or the error module directly.
export {
  DuplicateSkuError,
  ProductNotFoundError,
  SlugTakenError,
  VariantInUseError,
} from "@/server/catalog.errors";

export const catalogService = {
  // --- Storefront reads -----------------------------------------------------

  getStorefrontProducts(tenantId: string) {
    return productRepository.listActiveByTenant(tenantId);
  },

  getProductBySlug(tenantId: string, slug: string) {
    return productRepository.findBySlug(tenantId, slug);
  },

  /**
   * Storefront catalog search (#106). A thin pass-through to the repository's
   * tenant-scoped, ACTIVE-only ranked search — this layer binds the tenant to
   * the query and adds no other rule (the page zod-validates `page`/`pageSize`
   * and the raw `query`; the repository owns ranking, offset pagination, and the
   * empty-query short-circuit). Kept here so pages never import the repository
   * directly (golden rule 2).
   */
  searchStorefrontProducts(
    tenantId: string,
    params: Omit<SearchProductsParams, "tenantId">,
  ) {
    return productRepository.searchActiveByTenant({ tenantId, ...params });
  },

  // --- Admin reads ----------------------------------------------------------

  getAdminProducts(tenantId: string) {
    return productRepository.listAllByTenant(tenantId);
  },

  getAdminProduct(tenantId: string, id: string) {
    return productRepository.findByIdForTenant(tenantId, id);
  },

  // --- Admin writes ---------------------------------------------------------

  async createProduct(tenantId: string, input: ProductInput) {
    // Friendly pre-check; the DB unique + repo mapping is the race-safe backstop.
    const existing = await productRepository.findBySlug(tenantId, input.slug);
    if (existing) throw new SlugTakenError();
    return productRepository.createWithVariants(tenantId, input);
  },

  async updateProduct(tenantId: string, id: string, input: ProductInput) {
    const existing = await productRepository.findBySlug(tenantId, input.slug);
    // A matching slug is fine as long as it's this same product.
    if (existing && existing.id !== id) throw new SlugTakenError();
    const updated = await productRepository.updateWithVariants(
      tenantId,
      id,
      input,
    );
    if (!updated) throw new ProductNotFoundError();
    return updated;
  },

  async archiveProduct(tenantId: string, id: string) {
    const count = await productRepository.archive(tenantId, id);
    if (count === 0) throw new ProductNotFoundError();
  },
};
