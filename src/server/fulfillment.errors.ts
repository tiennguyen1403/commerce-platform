/**
 * Typed fulfillment errors, thrown by the fulfillment service and handled at its
 * caller boundary. When submission is wired through the transactional outbox
 * (M4 #139) the drain will treat every one of these as a *permanent* failure —
 * mark the message DEAD, no retry — exactly the way it already treats
 * `EmailNotConfiguredError`: an unconfigured provider, an unmapped variant, or a
 * missing shipping address is never fixed by retrying. Kept in a dependency-free
 * module so both the service and any retrying caller can import them without
 * depending on the service — mirrors `order.errors.ts` / `email.errors.ts`.
 */

/**
 * Provider submission was invoked but no fulfillment provider is configured —
 * `PRINTFUL_API_KEY` is unset and we're in production, so the selector returns no
 * mock (a mock must never "fulfill" a real paid order). The `EmailNotConfiguredError`
 * analogue for fulfillment: a *permanent* failure, so a retrying caller marks it
 * DEAD rather than backing off. Local dev/CI never hit this — the mock is the
 * default there.
 */
export class FulfillmentNotConfiguredError extends Error {
  constructor() {
    super(
      "Fulfillment is not configured — set PRINTFUL_API_KEY to enable provider submission.",
    );
    this.name = "FulfillmentNotConfiguredError";
  }
}

/**
 * One or more of the order's variants have no `providerVariantId` — the free-form
 * `sku` was never mapped to the provider's catalog id in the admin product form.
 * Submission is all-or-nothing: a single unmapped line fails the whole order (no
 * partial shipment), surfaced here as a defined, admin-fixable state rather than a
 * silent provider 4xx. Carries the offending SKUs so the failure is actionable
 * (which variants to map) and greppable in logs.
 */
export class FulfillmentNotMappedError extends Error {
  readonly skus: readonly string[];

  constructor(skus: readonly string[]) {
    super(
      `Order has ${skus.length} unmapped variant(s) (no providerVariantId): ${skus.join(", ")}.`,
    );
    this.name = "FulfillmentNotMappedError";
    this.skus = skus;
  }
}

/**
 * The order carries no complete shipping address, so there is nowhere to ship it.
 * A paid order should always have one — checkout collects and persists it (#135),
 * and the outbox only enqueues a submission when it's present (#139) — but the
 * `Order.ship*` columns are nullable for guest/legacy rows, so a missing address
 * is a defined, permanent failure here rather than a blank address sent to the
 * provider or an unsafe non-null assertion in the service.
 */
export class FulfillmentAddressMissingError extends Error {
  constructor(orderId: string) {
    super(`Order ${orderId} has no complete shipping address to fulfill.`);
    this.name = "FulfillmentAddressMissingError";
  }
}
