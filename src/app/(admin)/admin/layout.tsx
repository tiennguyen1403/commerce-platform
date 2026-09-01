import type { ReactNode } from "react";
import Link from "next/link";
import { Store } from "lucide-react";
import { requireAdminContext } from "@/server/auth/admin-context";
import { ROLES, hasAtLeast } from "@/config/roles";
import { SignOutButton } from "./sign-out-button";

export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  // Gates the entire /admin subtree; also resolves the tenant context that
  // child pages read via the same cached call.
  const { tenantName, userEmail, role } = await requireAdminContext();
  // Member management is OWNER-only. Hiding the link is UX, not a security
  // boundary — the page itself re-checks with `requireRole(OWNER)`.
  const canManageMembers = hasAtLeast(role, ROLES.OWNER);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-6">
            <Link
              href="/admin"
              className="inline-flex items-center gap-2 font-semibold tracking-tight"
            >
              <Store className="text-primary size-5" />
              {tenantName}
              <span className="text-muted-foreground text-sm font-normal">
                Admin
              </span>
            </Link>
            <nav className="flex items-center gap-4 text-sm">
              <Link
                href="/admin/products"
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                Products
              </Link>
              {canManageMembers ? (
                <Link
                  href="/admin/members"
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  Members
                </Link>
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
