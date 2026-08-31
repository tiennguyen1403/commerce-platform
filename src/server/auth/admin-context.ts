import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { tenantRepository } from "@/server/repositories/tenant.repository";
import { membershipRepository } from "@/server/repositories/membership.repository";
import { DEMO_TENANT_SLUG } from "@/config/constants";
import { ROLES, hasAtLeast, type Role } from "@/config/roles";

export interface AdminContext {
  userId: string;
  userName: string;
  userEmail: string;
  tenantId: string;
  tenantName: string;
  role: Role;
}

/**
 * Authoritative admin gate + tenant context, resolved once per request.
 *
 * The Prisma-backed session check lives here (a Node-runtime Server Component),
 * never in `proxy.ts` — the proxy only does the cheap optimistic cookie check.
 * `cache()` dedupes the work so the admin layout and every child admin page can
 * call this to read the resolved `tenantId` without re-querying.
 *
 * Redirects (never returns) unless the visitor is a signed-in member with at
 * least STAFF privileges in the demo tenant.
 */
export const requireAdminContext = cache(async (): Promise<AdminContext> => {
  const session = await auth.api.getSession({ headers: await headers() });
  // Not signed in — the cookie was missing, expired, or invalid.
  if (!session) redirect("/sign-in");

  const tenant = await tenantRepository.findBySlug(DEMO_TENANT_SLUG);
  // No demo tenant means the app was never seeded; there's nothing to admin.
  if (!tenant) redirect("/sign-in");

  const membership = await membershipRepository.findForUser(
    tenant.id,
    session.user.id,
  );
  // Signed in but not a member (or below STAFF): a valid user, not an admin —
  // send them to the storefront rather than a sign-in form they don't need.
  if (!membership || !hasAtLeast(membership.role, ROLES.STAFF)) {
    redirect("/");
  }

  return {
    userId: session.user.id,
    userName: session.user.name,
    userEmail: session.user.email,
    tenantId: tenant.id,
    tenantName: tenant.name,
    role: membership.role,
  };
});
