import type { ReactNode } from "react";
import Link from "next/link";
import { ShoppingCart, Store } from "lucide-react";
import { getStoreTenant } from "@/server/store-context";
import { readCart } from "@/server/cart-cookie";
import { cartItemCount } from "@/lib/cart";
import { Badge } from "@/components/ui/badge";

/**
 * Public storefront shell. Resolves the tenant once (cached) and shares its
 * name with the header; child pages read the same cached context for their data.
 * Every storefront route already renders on-demand (the list is `force-dynamic`,
 * the PDP is a dynamic segment, the cart reads cookies), so neither this DB read
 * nor the cart-cookie read below ever runs at build time.
 */
export default async function StorefrontLayout({
  children,
}: {
  children: ReactNode;
}) {
  const { tenantName } = await getStoreTenant();
  // Header badge is a cheap hint from the raw cookie; the cart page does the
  // authoritative re-pricing/reconciliation against live stock.
  const itemCount = cartItemCount(await readCart());

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
            <Link
              href="/cart"
              aria-label={`Cart, ${itemCount} ${itemCount === 1 ? "item" : "items"}`}
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-2 transition-colors"
            >
              <ShoppingCart className="size-5" />
              {itemCount > 0 ? (
                <Badge className="min-w-5 px-1.5 tabular-nums">
                  {itemCount}
                </Badge>
              ) : null}
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
