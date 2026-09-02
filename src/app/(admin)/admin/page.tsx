import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { membershipService } from "@/server/services/membership.service";

// Reads the session + the caller's memberships, so it can never be prerendered
// (there's no DB at build time). The admin chrome layout lives one segment down
// under `[storeSlug]`, so this bare entry has no dynamic layout above it to force
// that — declare it here.
export const dynamic = "force-dynamic";

/**
 * The bare `/admin` entry point — the generic destination the landing page and
 * the post-sign-in default point at, now that the admin area is path-scoped to
 * `/admin/[storeSlug]`. The proxy has already bounced anonymous visitors to
 * sign-in, so resolve the (optimistically) signed-in caller's stores and send
 * them into one.
 *
 * Until onboarding (#99) lets a user own more than one store, everyone has
 * exactly one, so a straight redirect is the whole story. The multi-store
 * chooser shown here and the in-admin switcher are #100, which replaces this
 * redirect with a picker when there's more than one store to choose from.
 */
export default async function AdminIndexPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  // Cookie present but invalid/expired (the proxy only checks presence).
  if (!session) redirect("/sign-in");

  const memberships = await membershipService.listStoresForUser(
    session.user.id,
  );
  // Signed in but a member of no store — not an admin of anything. Send them to
  // the platform root rather than a store admin they don't have.
  if (memberships.length === 0) redirect("/");

  redirect(`/admin/${memberships[0].tenant.slug}`);
}
