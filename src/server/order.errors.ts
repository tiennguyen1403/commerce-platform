/**
 * Typed order/checkout errors, thrown by the order repository/service and mapped
 * to friendly messages at the Server Action boundary. Kept in a dependency-free
 * module so the repository (which raises them from Prisma failures) and the
 * service (which raises them from business rules) can both import them without
 * either layer depending on the other — mirrors `catalog.errors.ts`.
 */

/** The cart reconciled to zero purchasable lines, so there is nothing to charge. */
export class EmptyCartError extends Error {
  constructor() {
    super("Your cart is empty.");
    this.name = "EmptyCartError";
  }
}

/**
 * The generated `orderNumber` collided with an existing one for the tenant
 * (unique on `[tenantId, orderNumber]`). The service catches this and retries
 * with a fresh number; it only surfaces if every bounded retry collides.
 */
export class OrderNumberTakenError extends Error {
  constructor() {
    super("Could not allocate an order number.");
    this.name = "OrderNumberTakenError";
  }
}

/**
 * A line couldn't be reserved at checkout because its sellable stock
 * (`stock - reserved`) fell short — someone else took the last units during the
 * shopper's session. Raised inside `createWithItems`'s transaction when the
 * atomic reserve guard matches zero rows, which rolls back the whole order (no
 * partial reservation). The checkout action maps it to a "sold out" message and
 * the orphaned PaymentIntent is cancelled by the service's existing catch.
 */
export class InsufficientStockError extends Error {
  constructor() {
    super("Some items just sold out.");
    this.name = "InsufficientStockError";
  }
}
