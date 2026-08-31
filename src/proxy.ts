import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Optimistic auth gate for the admin area (Next 16 renamed `middleware.ts` →
 * `proxy.ts`, and picks it up next to the `app` directory — here, `src/`).
 *
 * This runs on the Node runtime (the Next 16 default) but stays a cookie-only
 * check — no DB — per Next's own guidance, since it fires on every matched
 * request including prefetches. The authoritative session + membership check
 * lives in the admin layout (`src/app/(admin)/admin/layout.tsx`).
 */
export function proxy(request: NextRequest) {
  const sessionCookie = getSessionCookie(request);

  if (!sessionCookie) {
    const signInUrl = new URL("/sign-in", request.url);
    signInUrl.searchParams.set(
      "redirect",
      request.nextUrl.pathname + request.nextUrl.search,
    );
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin", "/admin/:path*"],
};
