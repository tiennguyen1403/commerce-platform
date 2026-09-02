"use client";

import Link from "next/link";
import { Check, ChevronsUpDown, Plus, Store } from "lucide-react";
import type { Role } from "@/config/roles";
import { ROLE_LABELS } from "@/lib/validators/members";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** One store the signed-in user belongs to, flattened for the switcher. */
export interface SwitcherStore {
  slug: string;
  name: string;
  role: Role;
}

/**
 * Jump between the stores the signed-in user administers. Each entry is a real
 * link to `/admin/<slug>` (the target store's layout re-runs the authoritative
 * gate and resolves that store's role), so a store the user isn't a member of
 * can never appear here and can't be reached by picking it — the list is built
 * from their own memberships upstream. Rendering links (not a value picker) keeps
 * middle-/cmd-click "open store in a new tab" working, which multi-store
 * operators lean on.
 *
 * The current store is included and marked; picking it returns to that store's
 * dashboard. The caller only mounts this when there's more than one store, so the
 * menu is never a dead end.
 */
export function StoreSwitcher({
  currentSlug,
  stores,
}: {
  currentSlug: string;
  stores: SwitcherStore[];
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Switch store"
        title="Switch store"
        className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 data-popup-open:bg-muted data-popup-open:text-foreground inline-flex size-8 items-center justify-center rounded-md transition-colors outline-none focus-visible:ring-[3px]"
      >
        <ChevronsUpDown className="size-4" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={8} className="min-w-60">
        <DropdownMenuLabel>Switch store</DropdownMenuLabel>
        {stores.map((store) => {
          const isCurrent = store.slug === currentSlug;
          return (
            <DropdownMenuLinkItem
              key={store.slug}
              closeOnClick
              aria-current={isCurrent ? "page" : undefined}
              render={<Link href={`/admin/${store.slug}`} />}
              className={cn(isCurrent && "bg-accent/40")}
            >
              <Store className="text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{store.name}</span>
              <span className="text-muted-foreground shrink-0 text-xs">
                {ROLE_LABELS[store.role]}
              </span>
              <Check
                className={cn("text-primary", !isCurrent && "invisible")}
                aria-hidden
              />
            </DropdownMenuLinkItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuLinkItem closeOnClick render={<Link href="/new" />}>
          <Plus className="text-muted-foreground" aria-hidden />
          Create store
        </DropdownMenuLinkItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
