import type { ReactNode } from "react";
import Link from "next/link";
import { LogIn, ShieldCheck, ShoppingCart } from "lucide-react";
import { getStoreTenant } from "@/server/store-context";
import { getShopperSession } from "@/server/auth/shopper-context";
import { readCart } from "@/server/cart-cookie";
import { cartItemCount } from "@/lib/cart";
import { tenantThemeCss } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { AccountMenu } from "./account/account-menu";
import { SearchForm } from "./search/search-form";
import { StoreBrand } from "./store-brand";
import { NavLink } from "./nav-link";
import { MobileNav } from "./mobile-nav";

/**
 * Public storefront shell. Resolves the tenant once (cached) and shares its
 * name with the header/footer; child pages read the same cached context for
 * their data. Every storefront route already renders on-demand (the list is
 * `force-dynamic`, the PDP is a dynamic segment, the cart reads cookies), so
 * none of these reads (tenant, shopper session, cart cookie) ever runs at build
 * time.
 *
 * Per-tenant accent (#98): the wrapper carries `data-tenant-theme` and an inline
 * `<style>` re-parametrizing the accent tokens by `themeHue`. Scoping to this
 * wrapper (not `:root`) keeps the override inside the storefront — the
 * `(admin)`/`(auth)` trees render as siblings under the root layout and are never
 * touched. SSR'd here, so the accent is correct on first paint with no flash.
 *
 * The chrome stays a Server Component; only the interactive bits are client
 * islands — the account dropdown (`AccountMenu`) and the mobile nav drawer
 * (`MobileNav`), both of which stamp `TENANT_THEME_PORTAL_ATTR` on their
 * body-portaled surfaces so the tenant accent survives the portal.
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

  // Only the serializable identity crosses into the client islands.
  const account = session
    ? { name: session.user.name, email: session.user.email }
    : null;
  const cartLabel = `Cart, ${itemCount} ${itemCount === 1 ? "item" : "items"}`;
  const year = new Date().getFullYear();
  const footerLink =
    "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 w-fit rounded-sm py-1 text-sm transition-colors outline-none focus-visible:ring-[3px]";

  return (
    <div data-tenant-theme="" className="flex min-h-dvh flex-col">
      <style dangerouslySetInnerHTML={{ __html: tenantThemeCss(themeHue) }} />
      <header className="border-b">
        {/* Desktop: brand + primary nav on the left; search, cart and account
            grouped on the right. The gap between the two clusters is where the
            nav grows as it gains entries. */}
        <div className="mx-auto hidden w-full max-w-6xl items-center gap-5 px-6 py-3 md:flex">
          <StoreBrand tenantName={tenantName} />
          <nav aria-label="Primary" className="flex items-center gap-1">
            <NavLink href="/products">Products</NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <SearchForm className="w-56" />
            <Link
              href="/cart"
              aria-label={cartLabel}
              className={cn(buttonVariants({ variant: "outline" }), "gap-2")}
            >
              <ShoppingCart className="size-4" aria-hidden />
              Cart
              {itemCount > 0 ? (
                <Badge className="tabular-nums">{itemCount}</Badge>
              ) : null}
            </Link>
            {account ? (
              <AccountMenu name={account.name} email={account.email} />
            ) : (
              <Link
                href="/account/sign-in"
                className={cn(buttonVariants({ variant: "ghost" }), "gap-1.5")}
              >
                <LogIn className="size-4" aria-hidden />
                Sign in
              </Link>
            )}
          </div>
        </div>

        {/* Mobile: the hamburger drawer holds search / nav / account; the cart
            stays in the bar so the funnel is one tap away. */}
        <div className="mx-auto flex w-full max-w-6xl items-center gap-1 px-4 py-2.5 md:hidden">
          <MobileNav
            tenantName={tenantName}
            itemCount={itemCount}
            account={account}
          />
          <StoreBrand tenantName={tenantName} className="min-w-0 flex-1" />
          <Link
            href="/cart"
            aria-label={cartLabel}
            className={cn(
              buttonVariants({ variant: "ghost", size: "icon" }),
              "relative",
            )}
          >
            <ShoppingCart className="size-5" aria-hidden />
            {itemCount > 0 ? (
              <Badge className="absolute -top-0.5 -right-0.5 h-4 min-w-4 justify-center rounded-full px-1 text-xs tabular-nums">
                {itemCount}
              </Badge>
            ) : null}
          </Link>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t">
        <div className="mx-auto w-full max-w-6xl px-6 py-12">
          <div className="grid grid-cols-1 gap-8 sm:grid-cols-[2fr_1fr_1fr]">
            <div className="flex flex-col gap-3">
              <StoreBrand tenantName={tenantName} />
              <p className="text-muted-foreground max-w-xs text-sm leading-6">
                Made to order by our print partner and shipped from the US.
              </p>
            </div>
            <nav
              aria-labelledby="footer-shop"
              className="flex flex-col items-start gap-1"
            >
              <h2 id="footer-shop" className="mb-1 text-sm font-medium">
                Shop
              </h2>
              <Link href="/products" className={footerLink}>
                All products
              </Link>
              <Link href="/search" className={footerLink}>
                Search
              </Link>
            </nav>
            <nav
              aria-labelledby="footer-account"
              className="flex flex-col items-start gap-1"
            >
              <h2 id="footer-account" className="mb-1 text-sm font-medium">
                Account
              </h2>
              {account ? (
                <Link href="/account/orders" className={footerLink}>
                  My orders
                </Link>
              ) : (
                <Link href="/account/sign-in" className={footerLink}>
                  Sign in
                </Link>
              )}
              <Link href="/cart" className={footerLink}>
                Cart
              </Link>
            </nav>
          </div>
          <div className="mt-10 flex flex-col gap-3 border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-muted-foreground text-sm">
              © {year} {tenantName}
            </p>
            <p className="text-muted-foreground inline-flex items-center gap-2 text-sm">
              <ShieldCheck className="size-4 shrink-0" aria-hidden />
              Secure checkout with Stripe
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
