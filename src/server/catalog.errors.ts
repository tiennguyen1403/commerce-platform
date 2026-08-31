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

/**
 * One or more variants an admin tried to remove already appear in an order, so
 * they can't be deleted — `OrderItem.variant` is `onDelete: Restrict` and order
 * history is permanent. Carries the offending SKUs when the service caught it
 * up front (so the form can name them); falls back to a generic message on the
 * race backstop, where the DB is the one that refused and the SKUs aren't known.
 */
export class VariantInUseError extends Error {
  constructor(skus?: string[]) {
    super(VariantInUseError.messageFor(skus));
    this.name = "VariantInUseError";
  }

  private static messageFor(skus?: string[]): string {
    if (!skus?.length) {
      return "A variant with existing orders can't be removed.";
    }
    const quoted = skus.map((sku) => `"${sku}"`).join(", ");
    return skus.length === 1
      ? `Variant ${quoted} has orders and can't be removed.`
      : `Variants ${quoted} have orders and can't be removed.`;
  }
}
