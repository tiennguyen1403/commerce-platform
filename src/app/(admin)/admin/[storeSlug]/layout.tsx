import type { ReactNode } from "react";
import Link from "next/link";
import { Store } from "lucide-react";
import { requireAdminContext } from "@/server/auth/admin-context";
import { membershipService } from "@/server/services/membership.service";
import { ROLES, hasAtLeast } from "@/config/roles";
import { SignOutButton } from "./sign-out-button";
import { StoreSwitcher } from "./store-switcher";

export default async function AdminLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ storeSlug: string }>;
}) {
  const { storeSlug } = await params;
  // Gates the entire /admin/[storeSlug] subtree for THIS store; also resolves
  // the tenant context that child pages read via the same cached call.
  const { tenantName, userEmail, role, userId } =
    await requireAdminContext(storeSlug);
  // Member management and store settings are OWNER-only. Hiding the links is
  // UX, not a security boundary — each page re-checks with `requireRole(OWNER)`.
  const isOwner = hasAtLeast(role, ROLES.OWNER);
  // The signed-in user's own stores, for the switcher — scoped to their
  // memberships, so a store they don't belong to can never surface. Only worth a
  // switcher when there's somewhere to switch to; a single-store owner keeps the
  // plain brand.
  const stores = await membershipService.listStoresForUser(userId);
  const canSwitch = stores.length > 1;
  // Every nav target is scoped to the active store.
  const base = `/admin/${storeSlug}`;

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-1.5">
              <Link
                href={base}
                className="inline-flex items-center gap-2 font-semibold tracking-tight"
              >
                <Store className="text-primary size-5" />
                {tenantName}
                <span className="text-muted-foreground text-sm font-normal">
                  Admin
                </span>
              </Link>
              {canSwitch ? (
                <StoreSwitcher
                  currentSlug={storeSlug}
                  stores={stores.map((store) => ({
                    slug: store.tenant.slug,
                    name: store.tenant.name,
                    role: store.role,
                  }))}
                />
              ) : null}
            </div>
            <nav className="flex items-center gap-4 text-sm">
              <Link
                href={`${base}/products`}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                Products
              </Link>
              <Link
                href={`${base}/orders`}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                Orders
              </Link>
              <Link
                href={`${base}/analytics`}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                Analytics
              </Link>
              {isOwner ? (
                <>
                  <Link
                    href={`${base}/members`}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Members
                  </Link>
                  <Link
                    href={`${base}/settings`}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Settings
                  </Link>
                </>
              ) : null}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground hidden text-sm sm:inline">
              {userEmail}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t">
        <div className="text-muted-foreground mx-auto w-full max-w-4xl px-6 py-6 text-sm">
          © {new Date().getFullYear()} {tenantName} · Admin
        </div>
      </footer>
    </div>
  );
}
