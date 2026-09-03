/**
 * Guard for post-auth redirect targets (the `?redirect=` param the sign-in and
 * sign-up pages honor). Returns a safe same-origin path to navigate to, or
 * `null` when there's nothing safe to honor (the caller falls back to its own
 * default). Shared by both auth pages so the check lives in exactly one place.
 *
 * A prefix check alone ("reject `//` and `/\`") is NOT enough: the WHATWG URL
 * parser — which the client router uses to decide internal vs. external — strips
 * ASCII TAB/LF/CR from a URL before parsing, so `"/\t//evil.com"` collapses to
 * `"///evil.com"` and resolves to an off-site origin; and a leading dot-segment
 * normalizes the same way, so `"/..//evil.com"` collapses to pathname
 * `"//evil.com"`. Both are classic open redirects (CWE-601) that slip straight
 * past a naive prefix test. Instead we resolve the target the way the router
 * will and — because normalization can turn an on-origin parse into a
 * protocol-relative *result* — validate the exact value we return, honoring it
 * only if it too lands back on our own origin. The unusable `.invalid` TLD is
 * the stand-in base, so any target that escapes to a real host is rejected.
 */
export function safeInternalPath(
  target: string | undefined | null,
): string | null {
  if (!target || !target.startsWith("/")) return null;
  try {
    const base = "https://placeholder.invalid";
    const url = new URL(target, base);
    if (url.origin !== base) return null;
    const path = url.pathname + url.search + url.hash;
    // The *normalized* pathname can itself be protocol-relative even when the
    // parse above stayed on-origin: "/..//evil.com" collapses the leading "/.."
    // and yields pathname "//evil.com" while `url.origin` is still the
    // placeholder, so the check above passes but the returned value re-resolves
    // off-site at the router. Re-check the exact value we return, the same way
    // the router will, and honor it only if it still lands on our own origin.
    if (new URL(path, base).origin !== base) return null;
    return path;
  } catch {
    return null;
  }
}
