"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutGrid,
  LogIn,
  LogOut,
  Menu,
  Package,
  ShoppingCart,
  User,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { TENANT_THEME_PORTAL_ATTR } from "@/lib/theme";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { StoreBrand } from "./store-brand";
import { SearchForm } from "./search/search-form";
import { useSignOut } from "./account/use-sign-out";

const sectionLabel =
  "text-muted-foreground px-3 pt-4 pb-1 text-xs font-medium tracking-wide uppercase";
const row =
  "flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors";

/**
 * The storefront's mobile navigation: a hamburger trigger and the left Sheet
 * drawer it opens, holding the search form, primary nav, and the shopper's
 * account actions (the desktop header lays these out inline instead). Rendered
 * only below `md`; the cart stays in the top bar so the funnel is always one tap
 * away.
 *
 * A client island — the Sheet is interactive and portals to `<body>`. Exactly
 * like {@link AccountMenu}'s dropdown (#113) it escapes the storefront's
 * `[data-tenant-theme]` wrapper, so the drawer content stamps the shared portal
 * marker to pull the per-tenant accent back in. Open state is controlled so any
 * navigation closes the drawer; sign-out is delegated to the shared
 * {@link useSignOut} hook (never a server action).
 */
export function MobileNav({
  tenantName,
  itemCount,
  account,
}: {
  tenantName: string;
  itemCount: number;
  account: { name?: string | null; email: string } | null;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const { signingOut, signOut } = useSignOut();

  const close = () => setOpen(false);
  const productsActive =
    pathname === "/products" || pathname.startsWith("/products/");
  const cartActive = pathname === "/cart";

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={<Button variant="ghost" size="icon" aria-label="Open menu" />}
      >
        <Menu className="size-5" aria-hidden />
      </SheetTrigger>
      <SheetContent
        side="left"
        className="w-80 max-w-[85%] gap-0 p-0"
        // #113: this drawer portals to <body>, so stamp the tenant-theme portal
        // marker to keep the store's accent (single source of truth in @/lib/theme).
        {...{ [TENANT_THEME_PORTAL_ATTR]: "" }}
      >
        <SheetHeader className="flex-row items-center border-b">
          <SheetTitle className="sr-only">Menu</SheetTitle>
          <SheetDescription className="sr-only">
            Browse the store and manage your account.
          </SheetDescription>
          <StoreBrand tenantName={tenantName} onClick={close} />
        </SheetHeader>

        <div className="flex flex-1 flex-col overflow-y-auto p-2">
          <div className="p-1 pb-2">
            <SearchForm label="Search products (menu)" />
          </div>

          <p className={sectionLabel}>Browse</p>
          <Link
            href="/products"
            onClick={close}
            aria-current={productsActive ? "page" : undefined}
            className={cn(
              row,
              productsActive
                ? "bg-accent text-accent-foreground"
                : "text-foreground hover:bg-muted",
            )}
          >
            <LayoutGrid className="size-5 shrink-0" aria-hidden />
            Products
          </Link>
          <Link
            href="/cart"
            onClick={close}
            aria-label={`Cart, ${itemCount} ${itemCount === 1 ? "item" : "items"}`}
            aria-current={cartActive ? "page" : undefined}
            className={cn(
              row,
              cartActive
                ? "bg-accent text-accent-foreground"
                : "text-foreground hover:bg-muted",
            )}
          >
            <ShoppingCart className="size-5 shrink-0" aria-hidden />
            Cart
            {itemCount > 0 ? (
              <Badge className="ml-auto tabular-nums">{itemCount}</Badge>
            ) : null}
          </Link>

          <div className="bg-border mx-3 my-2 h-px" />

          <p className={sectionLabel}>Account</p>
          {account ? (
            <>
              <div className="flex items-center gap-3 px-3 py-2">
                <span
                  aria-hidden
                  className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-full"
                >
                  <User className="size-5" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {account.name || "Your account"}
                  </span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {account.email}
                  </span>
                </span>
              </div>
              <Link
                href="/account/orders"
                onClick={close}
                className={cn(row, "text-foreground hover:bg-muted")}
              >
                <Package className="size-5 shrink-0" aria-hidden />
                My orders
              </Link>
              <button
                type="button"
                onClick={async () => {
                  if (await signOut()) close();
                }}
                disabled={signingOut}
                className={cn(
                  row,
                  "text-destructive hover:bg-destructive/10 w-full text-left disabled:pointer-events-none disabled:opacity-50",
                )}
              >
                <LogOut className="size-5 shrink-0" aria-hidden />
                Sign out
              </button>
            </>
          ) : (
            <Link
              href="/account/sign-in"
              onClick={close}
              className={cn(buttonVariants(), "mx-2 mt-1 gap-2")}
            >
              <LogIn className="size-4 shrink-0" aria-hidden />
              Sign in
            </Link>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
