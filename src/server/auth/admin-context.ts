import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { tenantRepository } from "@/server/repositories/tenant.repository";
import { membershipRepository } from "@/server/repositories/membership.repository";
import { ROLES, hasAtLeast, type Role } from "@/config/roles";
import { InsufficientRoleError } from "@/server/auth/rbac.errors";

export interface AdminContext {
  userId: string;
  userName: string;
  userEmail: string;
  tenantId: string;
  tenantName: string;
  /** The store's single currency (lowercase ISO 4217); variants inherit it. */
  currency: string;
  /** The store's storefront accent — an OKLCH hue angle (see `src/lib/theme.ts`).
   *  Read by the OWNER settings editor to seed the accent picker. */
  themeHue: number;
  role: Role;
  /** The store slug from the URL — thread it back into nav links, redirects,
   *  and Server Action revalidation so they stay scoped to the active store. */
  storeSlug: string;
}

/**
 * Authoritative admin gate + tenant context for the store named on the URL,
 * resolved once per request. The `storeSlug` comes from the `[storeSlug]` route
 * segment (pages/layout `await params`; Server Actions receive it as an
 * argument), never from a hard-coded demo slug — a user may own several stores,
 * so the URL says which one they're editing.
 *
 * The Prisma-backed session + membership check lives here (a Node-runtime Server
 * Component), never in `proxy.ts` — the proxy only does the cheap optimistic
 * cookie check. `cache()` keys on `storeSlug`, so the admin layout and every
 * child admin page (and the Server Actions) that pass the same slug share one
 * resolution without re-querying.
 *
 * Refuses (never returns) unless the visitor is a signed-in member with at least
 * STAFF privileges in THAT store. An unknown slug and a store the caller isn't a
 * member of are both a 404 — a non-member can't tell the two apart, so this
 * never leaks which stores exist.
 */
export const requireAdminContext = cache(
  async (storeSlug: string): Promise<AdminContext> => {
    const session = await auth.api.getSession({ headers: await headers() });
    // Not signed in — the cookie was missing, expired, or invalid.
    if (!session) redirect("/sign-in");

    const tenant = await tenantRepository.findBySlug(storeSlug);
    // No such store: a 404, indistinguishable from "you're not a member" below.
    if (!tenant) notFound();

    const membership = await membershipRepository.findForUser(
      tenant.id,
      session.user.id,
    );
    // Signed in but not a STAFF+ member of this store — refused. A 404 (not a
    // redirect) so a non-member can't probe which stores exist.
    if (!membership || !hasAtLeast(membership.role, ROLES.STAFF)) {
      notFound();
    }

    return {
      userId: session.user.id,
      userName: session.user.name,
      userEmail: session.user.email,
      tenantId: tenant.id,
      tenantName: tenant.name,
      currency: tenant.currency,
      themeHue: tenant.themeHue,
      role: membership.role,
      storeSlug,
    };
  },
);

/**
 * Page-level role gate for a store. Resolves the admin context (refusing a
 * visitor who isn't a STAFF+ member, per `requireAdminContext`), then redirects
 * a member below `min` back to that store's dashboard — a signed-in member who
 * simply lacks the privilege, not someone to bounce to a sign-in form. Reuses
 * the cached context, so gating a page adds no extra query. For use in Server
 * Components; Server Actions use `assertRole`.
 */
export async function requireRole(
  storeSlug: string,
  min: Role,
): Promise<AdminContext> {
  const ctx = await requireAdminContext(storeSlug);
  if (!hasAtLeast(ctx.role, min)) redirect(`/admin/${storeSlug}`);
  return ctx;
}

/**
 * Server Action role gate for a store. Same resolution as `requireRole`, but
 * throws `InsufficientRoleError` instead of redirecting (a redirect is
 * meaningless in an action's JSON response). Render-time nav gating is not a
 * security boundary, so every privileged action must re-check here — Server
 * Actions are public endpoints and the `storeSlug` they receive is
 * client-supplied, so this is the boundary that binds an action to a store the
 * caller may actually administer. The route/UI boundary maps the error to a
 * friendly message.
 */
export async function assertRole(
  storeSlug: string,
  min: Role,
): Promise<AdminContext> {
  const ctx = await requireAdminContext(storeSlug);
  if (!hasAtLeast(ctx.role, min)) throw new InsufficientRoleError();
  return ctx;
}
