import "server-only";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight, Plus, Store } from "lucide-react";
import { auth } from "@/server/auth";
import { membershipService } from "@/server/services/membership.service";
import type { Role } from "@/config/roles";
import { ROLE_LABELS } from "@/lib/validators/members";
import { Badge } from "@/components/ui/badge";

export const metadata: Metadata = { title: "Choose a store" };

// Reads the session + the caller's memberships, so it can never be prerendered
// (there's no DB at build time). The admin chrome layout lives one segment down
// under `[storeSlug]`, so this bare entry has no dynamic layout above it to force
// that — declare it here.
export const dynamic = "force-dynamic";

// Owner-first, so the store a user runs stands out from ones they merely help on.
const ROLE_BADGE: Record<Role, "default" | "secondary" | "outline"> = {
  OWNER: "default",
  ADMIN: "secondary",
  STAFF: "outline",
};

/**
 * The bare `/admin` entry point — the generic destination the landing page and
 * the post-sign-in default point at, now that the admin area is path-scoped to
 * `/admin/[storeSlug]`. The proxy has already bounced anonymous visitors to
 * sign-in, so resolve the (optimistically) signed-in caller's stores from here.
 *
 * One store is the common case (and the whole story until onboarding let a user
 * own more than one), so forward straight in — no need to make a lone owner pick
 * from a list of one. Only a genuine choice (two or more) renders the picker.
 */
export default async function AdminIndexPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  // Cookie present but invalid/expired (the proxy only checks presence).
  if (!session) redirect("/sign-in");

  // Scoped to the caller's own memberships, so a store they don't belong to
  // never appears — the same list the in-admin switcher is built from.
  const stores = await membershipService.listStoresForUser(session.user.id);
  // Signed in but a member of no store — not an admin of anything. Send them to
  // the platform root rather than a store admin they don't have.
  if (stores.length === 0) redirect("/");
  if (stores.length === 1) redirect(`/admin/${stores[0].tenant.slug}`);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-8 px-6 py-16">
      <div className="flex flex-col gap-3">
        <span className="border-border text-muted-foreground inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium">
          <Store className="size-3.5" aria-hidden />
          Your stores
        </span>
        <h1 className="text-3xl font-semibold tracking-tight">
          Choose a store
        </h1>
        <p className="text-muted-foreground text-sm leading-6">
          You&apos;re a member of {stores.length} stores. Pick one to manage its
          admin.
        </p>
      </div>

      <ul className="flex flex-col gap-3">
        {stores.map(({ role, tenant }) => (
          <li key={tenant.slug}>
            <Link
              href={`/admin/${tenant.slug}`}
              className="border-border hover:border-foreground/20 hover:bg-muted/40 focus-visible:ring-ring/50 group flex items-center gap-4 rounded-xl border px-4 py-3.5 transition-colors outline-none focus-visible:ring-[3px]"
            >
              <span className="bg-muted text-foreground/70 flex size-9 shrink-0 items-center justify-center rounded-lg">
                <Store className="size-4" aria-hidden />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{tenant.name}</span>
                <span className="text-muted-foreground truncate text-xs">
                  {tenant.slug}
                </span>
              </span>
              <Badge variant={ROLE_BADGE[role]}>{ROLE_LABELS[role]}</Badge>
              <ChevronRight
                className="text-muted-foreground size-4 shrink-0 transition-transform group-hover:translate-x-0.5"
                aria-hidden
              />
            </Link>
          </li>
        ))}
      </ul>

      <Link
        href="/new"
        className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-2 text-sm transition-colors"
      >
        <Plus className="size-4" aria-hidden />
        Create a new store
      </Link>
    </main>
  );
}
