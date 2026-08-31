import type { ReactNode } from "react";
import Link from "next/link";
import { requireAdminContext } from "@/server/auth/admin-context";
import { SignOutButton } from "./sign-out-button";

export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  // Gates the entire /admin subtree; also resolves the tenant context that
  // child pages read via the same cached call.
  const { tenantName, userEmail } = await requireAdminContext();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between gap-4 border-b px-6 py-3">
        <div className="flex items-baseline gap-2">
          <Link href="/admin" className="font-semibold tracking-tight">
            Admin
          </Link>
          <span className="text-muted-foreground text-sm">· {tenantName}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground hidden text-sm sm:inline">
            {userEmail}
          </span>
          <SignOutButton />
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
