/**
 * Typed outbox errors, thrown while draining the transactional-email outbox
 * (#30) and classified by the drain: a permanent failure is marked DEAD at once
 * rather than burning the retry budget. Kept dependency-free (like
 * `email.errors.ts` / `order.errors.ts`) so the service and any caller can import
 * it without depending on the service itself.
 */

/**
 * A message that can never be delivered no matter how many times it is retried —
 * there is no order to render it from, or its `type` has no send path. Distinct
 * from a *transient* fault (a Resend outage, a network blip), which the drain
 * retries with backoff. The drain marks an `OutboxPermanentError` DEAD on the
 * first attempt and reports it, since a paid order that can never be confirmed is
 * a data-integrity anomaly, not a passing storm.
 */
export class OutboxPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboxPermanentError";
  }
}

/**
 * A message whose `type` has no send path *yet* — it will, in a later issue, but
 * until then the drain must hold it, not fail it. Distinct from an
 * `OutboxPermanentError` (never deliverable → DEAD + alert): a deferred message is a
 * *legitimately enqueued* row awaiting code that hasn't shipped, so dead-lettering
 * it would permanently drop a real notification and false-alarm on the happy path.
 * The drain catches this and reschedules the row PENDING without counting an attempt
 * or ever marking it DEAD, so it waits safely for its send path to land.
 *
 * Used for `SHIPPING_CONFIRMATION`, which the poll-fulfillment cron enqueues (M4
 * #140) before the shipping-email send path exists (M4-08 / #141). Retire this the
 * moment every enqueued type has a real send path.
 */
export class OutboxDeferredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboxDeferredError";
  }
}
