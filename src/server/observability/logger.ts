import "server-only";
import pino from "pino";

/**
 * Structured application logger — a **bare `pino()`** that writes
 * newline-delimited JSON to stdout, with no transport.
 *
 * Why bare, and why no transport:
 *  - `pino.transport()` spins up a worker thread (`thread-stream`) which crashes
 *    under Turbopack (`vercel/next.js#84766`). The bare constructor writes
 *    synchronously to fd 1 with no worker — the standard serverless shape anyway:
 *    the platform (Vercel/Docker) collects stdout and parses the JSON lines.
 *  - `pino` (with `pino-pretty`/`pino-roll`/`thread-stream`) already ships in
 *    Next 16's default `serverExternalPackages`, so it's externalized from the
 *    server bundle with no `next.config` change.
 *
 * `import "server-only"` keeps it out of any client bundle — pino is Node-only.
 *
 * Correlation is explicit, not ambient: derive a request/tenant-scoped child with
 * `logger.child({ requestId, tenantId, … })` and thread it down as a trailing
 * argument, matching the repo's explicit-context style (no AsyncLocalStorage).
 *
 * A logged Error goes under the `err` key — pino's default serializer expands it
 * to `{ type, message, stack }`:  `log.error({ err }, "…")`.
 *
 * Dev pretty-printing stays out-of-process (never an in-process transport):
 *   pnpm dev | pnpm exec pino-pretty
 */
export const logger = pino({
  // `LOG_LEVEL` always wins when set; otherwise quieter in prod, chattier in dev.
  // Read straight from `process.env` (not the validated `@/lib/env`) on purpose:
  // this stays a foundational, dependency-free module so anything — including a
  // future env-validation failure path — can log through it without a cycle.
  level:
    process.env.LOG_LEVEL ??
    (process.env.NODE_ENV === "production" ? "info" : "debug"),
});

export type { Logger } from "pino";
