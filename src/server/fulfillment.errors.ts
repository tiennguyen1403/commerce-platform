/**
 * Typed fulfillment errors, thrown by the fulfillment service and handled at its
 * caller boundary. The outbox drain (M4 #139) treats every one of these as a
 * *permanent* failure — record the order as `FulfillmentStatus.FAILED`, mark the
 * message DEAD, no retry — exactly the way it already treats
 * `EmailNotConfiguredError`: an unconfigured provider, an unmapped variant, a
 * missing shipping address, or a provider soft-rejection is never fixed by
 * retrying. Kept in a dependency-free module so both the service and any retrying
 * caller can import them without depending on the service — mirrors
 * `order.errors.ts` / `email.errors.ts`.
 */

/**
 * Base class for every typed fulfillment error. All are *permanent* failures, so
 * both the submission service (records the order `FAILED`) and the outbox drain
 * (settles the message DEAD) key off a single `instanceof FulfillmentError` check
 * rather than enumerating subclasses — a new fulfillment error is permanent by
 * construction. A *transient* provider fault (a 5xx/timeout) is deliberately NOT
 * modelled here: the adapter throws a plain `Error` for those, which the outbox
 * retries with backoff. Abstract because it is never thrown directly.
 */
export abstract class FulfillmentError extends Error {}

/**
 * Provider submission was invoked but no fulfillment provider is configured —
 * `PRINTFUL_API_KEY` is unset and we're in production, so the selector returns no
 * mock (a mock must never "fulfill" a real paid order). The `EmailNotConfiguredError`
 * analogue for fulfillment: a *permanent* failure, so a retrying caller marks it
 * DEAD rather than backing off. Local dev/CI never hit this — the mock is the
 * default there.
 */
export class FulfillmentNotConfiguredError extends FulfillmentError {
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
export class FulfillmentNotMappedError extends FulfillmentError {
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
export class FulfillmentAddressMissingError extends FulfillmentError {
  constructor(orderId: string) {
    super(`Order ${orderId} has no complete shipping address to fulfill.`);
    this.name = "FulfillmentAddressMissingError";
  }
}

/**
 * The provider soft-rejected a submitted order — a resolved `FulfillmentResult`
 * with `status: "failed"` (e.g. Printful returned HTTP 400, or an order whose
 * `status` came back `failed`/`canceled`): a real, non-retryable rejection of THIS
 * order (a variant/address the provider won't accept), distinct from a transient
 * provider outage (a 5xx/timeout the adapter throws as a plain `Error` for the
 * outbox to retry). The submission service has already recorded the order as
 * `FulfillmentStatus.FAILED`; this carries the failure to the outbox, which — like
 * every `FulfillmentError` — settles the message DEAD and alerts. Deliberately
 * does NOT carry the provider's `externalId`: a soft rejection's id is a
 * synthesized placeholder that must never be persisted or reach `getTracking`; the
 * order id + provider name are enough to action the failure.
 */
export class FulfillmentRejectedError extends FulfillmentError {
  readonly orderId: string;
  readonly provider: string;

  constructor(orderId: string, provider: string) {
    super(
      `Order ${orderId} was rejected by the ${provider} fulfillment provider.`,
    );
    this.name = "FulfillmentRejectedError";
    this.orderId = orderId;
    this.provider = provider;
  }
}
