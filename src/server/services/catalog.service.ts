import { Prisma } from "@prisma/client";
import { productRepository } from "@/server/repositories/product.repository";
import type { ProductInput } from "@/lib/validators/catalog";

/**
 * Business logic for the catalog — storefront reads plus the admin write path
 * (validation rules, uniqueness, typed errors). Shape validation (zod) happens
 * at the Server Action boundary; this layer owns the business rules and throws
 * typed errors the boundary maps back to the form.
 */

/** A product with that slug already exists for the tenant. */
export class SlugTakenError extends Error {
  constructor() {
    super("A product with this slug already exists.");
    this.name = "SlugTakenError";
  }
}

/** Two variants in the same product were given the same SKU. */
export class DuplicateSkuError extends Error {
  constructor() {
    super("Each variant needs a unique SKU.");
    this.name = "DuplicateSkuError";
  }
}

/** No product with that id exists for the tenant. */
export class ProductNotFoundError extends Error {
  constructor() {
    super("Product not found.");
    this.name = "ProductNotFoundError";
  }
}

/**
 * Translate a Prisma unique-constraint violation into a typed catalog error so
 * a race that slips past the pre-check (or a duplicate SKU) still surfaces a
 * friendly, field-specific message instead of a 500.
 */
function toCatalogError(err: unknown): Error {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002"
  ) {
    const target = String(
      (err.meta as { target?: unknown } | undefined)?.target ?? "",
    );
    if (target.includes("slug")) return new SlugTakenError();
    if (target.includes("sku")) return new DuplicateSkuError();
  }
  return err instanceof Error ? err : new Error("Unexpected catalog error.");
}

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
    const existing = await productRepository.findBySlug(tenantId, input.slug);
    if (existing) throw new SlugTakenError();
    try {
      return await productRepository.createWithVariants(tenantId, input);
    } catch (err) {
      throw toCatalogError(err);
    }
  },

  async updateProduct(tenantId: string, id: string, input: ProductInput) {
    const existing = await productRepository.findBySlug(tenantId, input.slug);
    // A matching slug is fine as long as it's this same product.
    if (existing && existing.id !== id) throw new SlugTakenError();
    let updated;
    try {
      updated = await productRepository.updateWithVariants(tenantId, id, input);
    } catch (err) {
      throw toCatalogError(err);
    }
    if (!updated) throw new ProductNotFoundError();
    return updated;
  },

  async archiveProduct(tenantId: string, id: string) {
    const count = await productRepository.archive(tenantId, id);
    if (count === 0) throw new ProductNotFoundError();
  },
};
