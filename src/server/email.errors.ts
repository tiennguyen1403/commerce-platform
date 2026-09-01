/**
 * Typed email errors, thrown by the email service and handled at the caller
 * boundary (the Stripe webhook swallows them; a future outbox drain (#31) will
 * treat a permanent failure as DEAD). Kept in a dependency-free module so both
 * the service and any retrying caller can import them without depending on the
 * service itself — mirrors `order.errors.ts` / `catalog.errors.ts`.
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
