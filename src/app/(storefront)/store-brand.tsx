import Link from "next/link";
import { Store } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The store's brand lockup — an accent-tinted logo tile plus the tenant name,
 * linking to the catalog. Shared by the header (desktop + mobile rows), the
 * mobile nav drawer, and the footer so the four mounts can never drift.
 *
 * A plain shared component (no `"use client"`): it renders server-side in the
 * layout's header/footer and inside the client `MobileNav` island alike. The
 * optional `onClick` lets that island close its drawer when the brand is tapped.
 */
export function StoreBrand({
  tenantName,
  className,
  onClick,
}: {
  tenantName: string;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <Link
      href="/products"
      onClick={onClick}
      className={cn(
        "focus-visible:ring-ring/50 inline-flex shrink-0 items-center gap-2.5 rounded-md font-semibold tracking-tight outline-none focus-visible:ring-[3px]",
        className,
      )}
    >
      <span
        aria-hidden
        className="bg-accent text-primary flex size-8 shrink-0 items-center justify-center rounded-md"
      >
        <Store className="size-5" />
      </span>
      <span className="truncate">{tenantName}</span>
    </Link>
  );
}
