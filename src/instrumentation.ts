import type { Instrumentation } from "next";
import { reportError } from "@/server/observability/error-reporter";

/**
 * Next's server-error hook (stable since v15): the single place that catches
 * *unhandled* errors from RSC renders, route handlers, Server Actions, and the
 * proxy. Handlers that catch-and-swallow their own errors (the Stripe webhook,
 * checkout/catalog actions) never reach here, so those call `reportError`
 * directly at their catch sites.
 *
 * The whole app runs on the Node runtime (no Edge, no middleware), so this file
 * compiles for Node only and can safely pull in the pino-backed reporter.
 *
 * `error` is `unknown` and may be a React-processed wrapper rather than the
 * original throw — `reportError` narrows it and pino records the stack; the
 * `digest` (when present) ties it back to the client-visible error.
 */
export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context,
) => {
  // `"digest" in error` can be true with an undefined value — guard on the value
  // itself so a real, non-empty digest is forwarded and nothing becomes the
  // string "undefined".
  const rawDigest =
    typeof error === "object" && error !== null && "digest" in error
      ? (error as { digest: unknown }).digest
      : undefined;
  const digest = rawDigest ? String(rawDigest) : undefined;

  await reportError(error, {
    path: request.path,
    method: request.method,
    routeType: context.routeType,
    routePath: context.routePath,
    ...(digest ? { digest } : {}),
  });
};
