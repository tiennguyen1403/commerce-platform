"use client";

import Link from "next/link";
import { ChevronDown, LogOut, Package, User } from "lucide-react";

import { cn } from "@/lib/utils";
import { TENANT_THEME_PORTAL_ATTR } from "@/lib/theme";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSignOut } from "./use-sign-out";

/**
 * The signed-in half of the storefront nav (desktop). The layout reads the
 * session server-side (an optimistic, non-gating read — it never redirects a
 * guest) and passes only the serializable identity here; the authoritative
 * access checks live on the gated pages (e.g. `/account`), never on this chrome.
 * Interactive (a menu + sign-out), so it's a client island; the mobile drawer
 * (`MobileNav`) renders the same actions inline.
 *
 * The menu popup portals to `<body>`, escaping the storefront's
 * `[data-tenant-theme]` wrapper — so, exactly like `SelectContent` (#113), it
 * stamps the shared portal marker to pull the per-tenant accent back in.
 * Sign-out is delegated to the shared {@link useSignOut} hook (client-driven,
 * never a server action, so it can't touch another identity).
 */
export function AccountMenu({
  name,
  email,
}: {
  name?: string | null;
  email: string;
}) {
  const { signingOut, signOut } = useSignOut();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account menu"
        className={cn(
          "hover:bg-muted data-popup-open:bg-muted focus-visible:ring-ring/50 inline-flex h-8 items-center gap-2 rounded-lg py-1 pr-2 pl-1 text-sm transition-colors outline-none focus-visible:ring-[3px]",
        )}
      >
        <span
          aria-hidden
          className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full"
        >
          <User className="size-4" />
        </span>
        <span className="hidden max-w-32 truncate sm:inline">
          {name || email}
        </span>
        <ChevronDown
          className="text-muted-foreground size-4 shrink-0"
          aria-hidden
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="min-w-56"
        // #113: this popup portals to <body>, so stamp the tenant-theme portal
        // marker to keep the store's accent (single source of truth in @/lib/theme).
        {...{ [TENANT_THEME_PORTAL_ATTR]: "" }}
      >
        {/* Base UI's Menu.GroupLabel (our DropdownMenuLabel) requires a
            Menu.Group ancestor for its context — rendering it bare throws at
            runtime (Base UI error #31). Wrap the identity header in a group. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            <span className="text-foreground truncate font-medium">
              {name || "Your account"}
            </span>
            <span className="truncate font-normal">{email}</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLinkItem
          closeOnClick
          render={<Link href="/account/orders" />}
        >
          <Package aria-hidden />
          My orders
        </DropdownMenuLinkItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={signOut}
          disabled={signingOut}
        >
          <LogOut aria-hidden />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
