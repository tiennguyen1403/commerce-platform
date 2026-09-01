import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Bearer-token gate for the `GET /api/cron/*` routes (issue #53).
 *
 * `CRON_SECRET` is read straight from `process.env`, **never** through
 * `@/lib/env`'s strict schema — deliberately. That keeps it *lazy*: a missing or
 * blank secret makes this return `false` (the route then answers 401) instead of
 * throwing at boot and taking the whole storefront down over a value only the
 * cron endpoints need. It also fails **closed** — with no secret configured, no
 * caller can ever be authorized.
 *
 * Both schedulers send the same header, so one check covers both:
 *  - the GitHub Actions workflow (`.github/workflows/cron.yml`) curls it explicitly;
 *  - Vercel Cron attaches `Authorization: Bearer $CRON_SECRET` automatically when
 *    the env var is set on the deployment (Vercel docs → "Securing cron jobs").
 */

const BEARER_PREFIX = "Bearer ";

/**
 * Constant-time string compare that tolerates unequal lengths.
 * `timingSafeEqual` throws when its two buffers differ in length, and guarding
 * that with a plain `a.length === b.length` check would leak the secret's length
 * through timing. Hashing both sides to a fixed 32-byte SHA-256 digest first
 * sidesteps both problems: the digests are always the same length, so the
 * comparison is a single constant-time operation that reveals nothing about the
 * secret — an attacker only ever learns whether their own guess matched.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Is this request an authenticated cron invocation? Returns `true` only when the
 * request carries `Authorization: Bearer <CRON_SECRET>` matching the configured
 * secret. Any other outcome — no secret configured, missing header, wrong scheme,
 * empty or mismatched token — returns `false`.
 */
export function verifyCronRequest(request: Request): boolean {
  // Fail closed: an unset or whitespace-only secret means nobody is authorized.
  // Detect "blank" with a trimmed check, but compare against the *raw* configured
  // value so the gate matches exactly what the schedulers send (Vercel forwards
  // the env var verbatim) rather than a trimmed copy of it.
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.trim() === "") return false;

  const header = request.headers.get("authorization");
  if (!header || !header.startsWith(BEARER_PREFIX)) return false;

  const token = header.slice(BEARER_PREFIX.length);
  if (!token) return false;

  return timingSafeStringEqual(token, secret);
}
