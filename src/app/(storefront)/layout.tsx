import type { ReactNode } from "react";
import Link from "next/link";
import { Store } from "lucide-react";
import { getStoreTenant } from "@/server/store-context";

/**
 * Public storefront shell. Resolves the tenant once (cached) and shares its
 * name with the header; child pages read the same cached context for their
 * data. Both storefront routes render on-demand (the list is `force-dynamic`,
 * the PDP is a dynamic segment), so this DB read never runs at build time.
 */
export default async function StorefrontLayout({
  children,
}: {
  children: ReactNode;
}) {
  const { tenantName } = await getStoreTenant();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-4">
          <Link
            href="/products"
            className="inline-flex items-center gap-2 font-semibold tracking-tight"
          >
            <Store className="size-5" />
            {tenantName}
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link
              href="/products"
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              Products
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t">
        <div className="text-muted-foreground mx-auto w-full max-w-6xl px-6 py-6 text-sm">
          © {new Date().getFullYear()} {tenantName}
        </div>
      </footer>
    </div>
  );
}
