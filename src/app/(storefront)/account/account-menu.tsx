"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, CircleUser, LogOut, Package } from "lucide-react";
import { authClient } from "@/server/auth/client";
import { TENANT_THEME_PORTAL_ATTR } from "@/lib/theme";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The signed-in half of the storefront nav. The layout reads the session
 * server-side (an optimistic, non-gating read — it never redirects a guest) and
 * passes only the serializable identity here; the authoritative access checks
 * live on the gated pages (e.g. `/account`), never on this chrome. Interactive
 * (a menu + sign-out), so it's a client island.
 *
 * The menu popup portals to `<body>`, escaping the storefront's
 * `[data-tenant-theme]` wrapper — so, exactly like `SelectContent` (#113), it
 * stamps the shared portal marker to pull the per-tenant accent back in. Sign-out
 * is client-driven (`authClient.signOut`, never a server action, so it can't
 * touch another identity); afterwards we send the shopper to the catalog and
 * refresh so the server re-renders the nav in its guest state.
 */
export function AccountMenu({
  name,
  email,
}: {
  name?: string | null;
  email: string;
}) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await authClient.signOut();
      router.push("/products");
      router.refresh();
    } catch (error) {
      // Keep the shopper where they are and let them retry rather than fail silently.
      console.error("Sign out failed", error);
      setSigningOut(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account menu"
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 data-popup-open:text-foreground inline-flex items-center gap-1.5 rounded-md text-sm transition-colors outline-none focus-visible:ring-[3px]"
      >
        <CircleUser className="size-5" aria-hidden />
        <span className="hidden max-w-32 truncate sm:inline">
          {name || email}
        </span>
        <ChevronDown className="size-4" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="min-w-56"
        // #113: this popup portals to <body>, so stamp the tenant-theme portal
        // marker to keep the store's accent (single source of truth in @/lib/theme).
        {...{ [TENANT_THEME_PORTAL_ATTR]: "" }}
      >
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="text-foreground truncate font-medium">
            {name || "Your account"}
          </span>
          <span className="truncate font-normal">{email}</span>
        </DropdownMenuLabel>
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
          onClick={handleSignOut}
          disabled={signingOut}
        >
          <LogOut aria-hidden />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
