import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { auth, type Session } from "@/server/auth";
import { logger } from "@/server/observability/logger";

const log = logger.child({ component: "shopper-session" });

/**
 * The signed-in shopper for the current request, or `null` for a guest.
 *
 * The storefront counterpart to `requireAdminContext` — but the opposite
 * posture, because the store is **public**:
 *  - it NEVER redirects (a guest is the normal visitor, not someone to bounce to
 *    a sign-in form), and
 *  - it NEVER throws: even a transient failure reading the session store must
 *    degrade to "guest" rather than 500 a public page. The ordinary "no session"
 *    case already returns `null` without throwing; the try/catch only guards an
 *    unexpected read failure (e.g. the session store momentarily unavailable),
 *    which is logged — a real fault worth seeing — before resolving to `null`.
 *
 * `cache()` dedupes the read across the storefront layout, the page, and any
 * Server Action within one request — the same request-scoped memoization
 * `requireAdminContext` relies on.
 *
 * Consumers: checkout, to stamp `Order.userId` server-side (never from the
 * client, per #102); and, later, the storefront nav to reflect signed-in state.
 */
export const getShopperSession = cache(async (): Promise<Session | null> => {
  try {
    return await auth.api.getSession({ headers: await headers() });
  } catch (err) {
    log.warn(
      { err },
      "getShopperSession: session read failed; treating visitor as a guest",
    );
    return null;
  }
});
