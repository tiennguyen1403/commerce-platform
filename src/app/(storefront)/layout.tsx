import type { ReactNode } from "react";
import Link from "next/link";
import { LogIn, ShoppingCart, Store } from "lucide-react";
import { getStoreTenant } from "@/server/store-context";
import { getShopperSession } from "@/server/auth/shopper-context";
import { readCart } from "@/server/cart-cookie";
import { cartItemCount } from "@/lib/cart";
import { tenantThemeCss } from "@/lib/theme";
import { Badge } from "@/components/ui/badge";
import { AccountMenu } from "./account/account-menu";
import { SearchForm } from "./search/search-form";

/**
 * Public storefront shell. Resolves the tenant once (cached) and shares its
 * name with the header; child pages read the same cached context for their data.
 * Every storefront route already renders on-demand (the list is `force-dynamic`,
 * the PDP is a dynamic segment, the cart reads cookies), so none of these reads
 * (tenant, shopper session, cart cookie) ever runs at build time.
 *
 * Per-tenant accent (#98): the wrapper carries `data-tenant-theme` and an inline
 * `<style>` re-parametrizing the accent tokens by `themeHue`. Scoping to this
 * wrapper (not `:root`) keeps the override inside the storefront — the
 * `(admin)`/`(auth)` trees render as siblings under the root layout and are never
 * touched. SSR'd here, so the accent is correct on first paint with no flash.
 */
export default async function StorefrontLayout({
  children,
}: {
  children: ReactNode;
}) {
  // Two per-request DB reads in parallel: the tenant, and the shopper session.
  // The session read is optimistic and non-gating — it never redirects a guest
  // (the store is public) and degrades to `null` on failure — so it only decides
  // which nav chrome to show; the gated pages (`/account`) re-check for real.
  const [{ tenantName, themeHue }, session] = await Promise.all([
    getStoreTenant(),
    getShopperSession(),
  ]);
  // Header badge is a cheap hint from the raw cookie; the cart page does the
  // authoritative re-pricing/reconciliation against live stock.
  const itemCount = cartItemCount(await readCart());

  return (
    <div data-tenant-theme="" className="flex min-h-dvh flex-col">
      <style dangerouslySetInnerHTML={{ __html: tenantThemeCss(themeHue) }} />
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-3 px-6 py-4">
          <Link
            href="/products"
            className="inline-flex shrink-0 items-center gap-2 font-semibold tracking-tight"
          >
            <Store className="text-primary size-5" />
            {tenantName}
          </Link>
          <SearchForm className="order-last w-full min-w-0 sm:order-none sm:ml-auto sm:w-56" />
          <nav className="ml-auto flex shrink-0 items-center gap-4 text-sm sm:ml-0">
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
            {session ? (
              <AccountMenu
                name={session.user.name}
                email={session.user.email}
              />
            ) : (
              <Link
                href="/account/sign-in"
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 transition-colors"
              >
                <LogIn className="size-4" aria-hidden />
                Sign in
              </Link>
            )}
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
