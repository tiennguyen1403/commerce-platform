import "server-only";
import { z } from "zod";

// Server-side environment variables, validated once at startup.
// Client code must read `NEXT_PUBLIC_*` from `process.env` directly.

/**
 * An optional string var where a *blank* value (`""` or whitespace — e.g. a
 * placeholder `KEY=` line in `.env`) reads the same as unset: `undefined`. Use
 * for best-effort config that must never crash boot, so callers can treat
 * "absent" and "left blank" identically with a single truthy check.
 */
const optionalEnvString = z
  .string()
  .optional()
  .transform((value) => (value && value.trim() !== "" ? value : undefined));

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(1),
  BETTER_AUTH_URL: z.string().min(1),
  // Required from Phase 1 checkout on: the app can't take payments without them.
  // The publishable key is deliberately absent — it's a `NEXT_PUBLIC_*` value the
  // client reads straight from `process.env`, never through this server-only file.
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  // Resend transactional email — OPTIONAL, validated at send time, not boot (#39).
  // The order-confirmation email is best-effort: it's sent from the Stripe
  // webhook's PENDING → PAID transition, which already swallows send failures so a
  // Resend outage never fails a paid order. Requiring these at boot would let a
  // missing/blank value take down the whole storefront + checkout — a blast radius
  // far larger than the best-effort email it guards. Unset (or blank) is fine; the
  // email service then throws `EmailNotConfiguredError` at send time instead
  // (`src/server/services/email.service.ts`). `EMAIL_FROM` is the verified Resend
  // sender in friendly-name form `"Store <sender@domain>"` (a bare address works too).
  RESEND_API_KEY: optionalEnvString,
  EMAIL_FROM: optionalEnvString,
  // Optional error-alert webhook (a Slack/Discord incoming-webhook URL). When set,
  // `reportError` POSTs a compact summary of each reported error here so alerts
  // outlive Vercel Hobby's 1-hour log retention. Best-effort, validated at use and
  // never at boot (same reasoning as the Resend keys above): unset/blank disables
  // the POST — logs still emit — and a bad URL only fails that one fire-and-forget
  // fetch, which must never keep the app from booting.
  ERROR_WEBHOOK_URL: optionalEnvString,
  // Printful (print-on-demand) API token — OPTIONAL, validated at use, not boot,
  // exactly like RESEND_API_KEY above. Fulfillment submission is a best-effort
  // background job (via the outbox), so a missing/blank key must never take down
  // checkout/storefront boot: it only makes the provider selector fall back to the
  // deterministic mock in dev/test, or — in production with no key — surface a
  // `FulfillmentNotConfiguredError` at submit time (the exact analogue of
  // `EmailNotConfiguredError`). Never a `NEXT_PUBLIC_*`; read only inside
  // `src/server/fulfillment/**` (the provider selector, `index.ts`).
  PRINTFUL_API_KEY: optionalEnvString,
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:", parsed.error.issues);
  throw new Error("Invalid environment variables");
}

export const env = parsed.data;
