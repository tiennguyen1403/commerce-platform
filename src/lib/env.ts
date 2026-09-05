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
  // Vercel Blob storage token — OPTIONAL, validated at use, not boot, exactly like
  // RESEND_API_KEY / PRINTFUL_API_KEY above (M5 #185). Product-image storage is not
  // on the checkout/storefront-boot path, so a missing/blank token must never take
  // down boot: it only makes the storage selector fall back to the local-disk mock
  // in dev/test, or — in production with no token — surface a
  // `StorageNotConfiguredError` at the upload/delete boundary (the exact analogue of
  // `FulfillmentNotConfiguredError`). Never a `NEXT_PUBLIC_*` — a read-write blob
  // token is a secret; read only inside `src/server/storage/**` (the selector,
  // `index.ts`). The real Vercel Blob adapter that consumes it lands in M5-06.
  BLOB_READ_WRITE_TOKEN: optionalEnvString,
  // Stuck-open-shipment age threshold, in DAYS (M4 #162). How long an order may sit
  // SUBMITTED but un-shipped before the fulfillment poll surfaces it as a STUCK open
  // shipment for an operator to chase (M4 #155) — a provider hold (`onhold`/`inreview`)
  // that isn't resolving. OPTIONAL and server-only (read only in
  // `src/server/services/fulfillment.service.ts`): unset OR blank keeps the built-in
  // 10-day default, so today's behaviour needs no `.env` entry. Env-tunable so the value
  // can be adjusted without a deploy once real Printful timing data exists — until then
  // 10 days is a deliberately generous, still-provisional buffer over Printful's
  // produce-and-ship window (a tracking number is assigned at carrier handoff, up to
  // ~a week). Blank/unset reads as unset and takes the default, like `optionalEnvString`
  // above — but UNLIKE those optional secrets, a present-but-malformed value (non-numeric
  // or non-positive) fails fast at boot rather than silently falling back: a numeric knob's
  // well-formedness is checkable up front, and a silent fallback would mask an operator
  // typo (they'd believe stuck-detection runs at their value while it quietly runs at 10).
  FULFILLMENT_STUCK_THRESHOLD_DAYS: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed ? Number(trimmed) : undefined;
    })
    .pipe(z.number().positive().default(10)),
  // Erroring-open-shipment alert threshold, a positive COUNT of consecutive failed
  // `getTracking` polls (M4 #172; the erroring-streak sibling of the age-based
  // `FULFILLMENT_STUCK_THRESHOLD_DAYS` above, made tunable the same way #162 did that one).
  // How many runs in a row `getTracking` may throw before the fulfillment poll surfaces an
  // order as ERRORING for an operator to chase (M4 #163) — tracking unreadable (a bad/stale
  // external id or a persistent provider fault), money captured, no reconciliation possible.
  // OPTIONAL and server-only (read only in `src/server/services/fulfillment.service.ts`):
  // unset OR blank keeps the built-in 144 default (≈ 24h at the every-10-minute cron cadence),
  // so today's behaviour needs no `.env` entry. Env-tunable so the value can be adjusted
  // without a deploy — provisional until real Printful error data exists, and cadence-coupled
  // by construction (the wall-clock 144 represents shifts if the cron interval changes), so
  // revisit it alongside any such change. Blank/unset reads as unset and takes the default,
  // like `optionalEnvString` above — but UNLIKE those optional secrets, a present-but-malformed
  // value fails fast at boot rather than silently falling back (same reasoning as the stuck
  // knob: a numeric knob's well-formedness is checkable up front, and a silent fallback would
  // mask an operator typo — they'd believe erroring-detection runs at their value while it
  // quietly ran at 144). Validated as `.int()` (NOT just `.positive()` like the stuck-days
  // knob, which multiplies into milliseconds and may be fractional): the alert is an EXACT
  // `count === threshold` match against an always-integer poll count, so a fractional value
  // would boot yet never fire — the very silent-typo failure fail-fast exists to prevent.
  FULFILLMENT_ERROR_ALERT_THRESHOLD: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed ? Number(trimmed) : undefined;
    })
    .pipe(z.number().int().positive().default(144)),
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
