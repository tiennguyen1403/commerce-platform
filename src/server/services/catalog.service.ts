import { productRepository } from "@/server/repositories/product.repository";
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
