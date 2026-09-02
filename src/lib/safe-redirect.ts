/**
 * Guard for post-auth redirect targets (the `?redirect=` param the sign-in and
 * sign-up pages honor). Returns a safe same-origin path to navigate to, or
 * `null` when there's nothing safe to honor (the caller falls back to its own
 * default). Shared by both auth pages so the check lives in exactly one place.
 *
 * A prefix check alone ("reject `//` and `/\`") is NOT enough: the WHATWG URL
 * parser — which the client router uses to decide internal vs. external — strips
 * ASCII TAB/LF/CR from a URL before parsing, so `"/\t//evil.com"` collapses to
 * `"///evil.com"` and resolves to an off-site origin. That's a classic open
 * redirect (CWE-601) that slips straight past a naive prefix test. Instead we
 * resolve the target the same way the router will and honor it only if it lands
 * back on our own origin — this can't diverge from the sink. The unusable
 * `.invalid` TLD is the stand-in base, so any target that escapes to a real host
 * fails the origin check and is rejected.
 */
export function safeInternalPath(
  target: string | undefined | null,
): string | null {
  if (!target || !target.startsWith("/")) return null;
  try {
    const url = new URL(target, "https://placeholder.invalid");
    if (url.origin !== "https://placeholder.invalid") return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}
