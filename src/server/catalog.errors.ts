/**
 * Typed catalog errors, thrown by the repository/service and mapped to
 * field-level messages at the Server Action boundary. Kept in a dependency-free
 * module so both the repository (which raises them from Prisma failures) and the
 * service (which raises them from business rules) can import them without either
 * layer depending on the other.
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
