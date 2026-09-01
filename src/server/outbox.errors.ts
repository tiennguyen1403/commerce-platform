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
