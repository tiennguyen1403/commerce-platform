import "server-only";
import { env } from "@/lib/env";
import { logger } from "./logger";

/**
 * Free-form correlation attached to a reported error (requestId, tenantId, route,
 * action, …). Deliberately open — call sites pass whatever they know, no schema.
 */
export type ErrorContext = Record<string, unknown>;

/**
 * The one seam through which an unexpected/handled error is reported.
 *
 * Shaped like Sentry's `captureException(error, context?)` on purpose: this whole
 * module is a thin, swappable seam. `@sentry/nextjs` is deliberately NOT installed
 * — 10.38.0+ crashes in production under Next 16 + Turbopack
 * (`getsentry/sentry-javascript#19367`, closed "not planned"). When Sentry ships a
 * real fix, this body can forward to it without touching a single call site.
 *
 * It does two things and never throws (a reporter that fails must not take down
 * the request it is reporting on):
 *   1. always logs a structured, error-level line;
 *   2. if `ERROR_WEBHOOK_URL` is set, POSTs a compact summary to it (Slack/Discord)
 *      — which outlives Vercel Hobby's 1-hour log retention, where step 1's JSON
 *      is gone within the hour.
 *
 * Wired at `src/instrumentation.ts`'s `onRequestError` (for unhandled RSC / route
 * / Server-Action / proxy errors) and at the explicit catch sites that swallow an
 * error before it can reach that hook (the Stripe webhook, checkout, and
 * catalog-write actions).
 */
export async function reportError(
  error: unknown,
  context: ErrorContext = {},
): Promise<void> {
  // Normalize to an Error so message/stack serialize consistently, whatever was
  // thrown (a string, a non-Error object, …).
  const err = error instanceof Error ? error : new Error(String(error));

  // (1) Always log — the guaranteed step. pino's default `err` serializer expands
  // type/message/stack; `err` goes last so a stray `context.err` can't shadow the
  // real error.
  logger.error({ ...context, err }, err.message);

  // (2) Best-effort chat fan-out. Absent/blank URL → logs only (the common case).
  const webhookUrl = env.ERROR_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    // Built inside the try so nothing here — including an exotic context value's
    // `toString` — can throw after the guaranteed log above.
    const summary = formatSummary(err, context);
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `text` (Slack) and `content` (Discord) carry the same human summary, so a
      // single URL works for either without knowing which it points at. The
      // structured fields ride along for richer relays that read them.
      body: JSON.stringify({
        text: summary,
        content: summary,
        error: { name: err.name, message: err.message },
        context,
      }),
      // Never let a slow/hung endpoint stall the request we are already failing.
      signal: AbortSignal.timeout(2000),
    });
  } catch (postError) {
    // The webhook is best-effort; a delivery failure must not propagate. Log it
    // (so a broken URL is visible) and move on.
    logger.error(
      {
        err:
          postError instanceof Error ? postError : new Error(String(postError)),
      },
      "reportError: failed to POST to ERROR_WEBHOOK_URL",
    );
  }
}

/** Compact one-liner for a chat webhook: env-tagged name + message + context. */
function formatSummary(err: Error, context: ErrorContext): string {
  const where = Object.entries(context)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  const envTag = env.NODE_ENV;
  return `⚠️ [${envTag}] ${err.name}: ${err.message}${where ? ` — ${where}` : ""}`;
}
