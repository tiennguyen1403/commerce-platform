/**
 * Typed email errors, thrown by the email service and handled at the caller
 * boundary — the outbox drain (#30) treats a permanent failure like this as DEAD
 * (no retry), while a transient Resend outage backs off and retries. Kept in a
 * dependency-free module so both the service and any retrying caller can import
 * them without depending on the service itself — mirrors `order.errors.ts` /
 * `catalog.errors.ts`.
 */

/**
 * Transactional email was invoked but Resend isn't configured (`RESEND_API_KEY` /
 * `EMAIL_FROM` unset or blank — see `src/lib/env.ts`, #39). A *permanent* failure:
 * unlike a transient Resend outage, retrying won't help, so a retrying caller can
 * distinguish it (mark it DEAD rather than backing off). The Stripe webhook
 * swallows it, so a store that never set up email still completes checkout — the
 * email is best-effort; the PAID order is the durable record.
 */
export class EmailNotConfiguredError extends Error {
  constructor() {
    super(
      "Transactional email is not configured — set RESEND_API_KEY and EMAIL_FROM to enable sending.",
    );
    this.name = "EmailNotConfiguredError";
  }
}

/**
 * A single Resend API call exceeded its timeout and was abandoned (#31). Unlike
 * `EmailNotConfiguredError` this is a *transient* failure — a retry may well
 * succeed — so a retrying caller (the outbox drain) backs off and tries again
 * rather than marking it DEAD. It exists chiefly so a hung Resend call can't hold
 * the Stripe webhook's 200 open toward Stripe's own delivery timeout: the send is
 * bounded, and this is what that bound throws.
 */
export class EmailSendTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Resend send timed out after ${timeoutMs}ms`);
    this.name = "EmailSendTimeoutError";
  }
}
