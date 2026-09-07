"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

/**
 * A primary-nav link for the storefront header that highlights when its section
 * is active. Client-only (it reads `usePathname`); the header is otherwise a
 * Server Component. Kept generic so the header's nav can grow past the single
 * "Products" entry without each item re-deriving its own active state.
 */
export function NavLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "focus-visible:ring-ring/50 inline-flex h-8 items-center rounded-lg px-2.5 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px]",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      {children}
    </Link>
  );
}
