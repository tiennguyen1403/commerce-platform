import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Card, CardContent } from "@/components/ui/card";

/**
 * A titled panel for the account cluster: an accent icon chip, a heading + an
 * optional one-line description, then the section's content.
 *
 * Mirrors the checkout → confirmation `SectionPanel` idiom
 * (`checkout/success/page.tsx`) so the whole order flow — checkout, its
 * confirmation, and the shopper's account/order pages — reads as one designed
 * piece. Server-safe (no `"use client"`) and local to the account route group,
 * shared by the account home and order-detail pages. `role="group"` + the
 * labelled heading name the region for assistive tech.
 *
 * (The confirmation page keeps its own near-identical local copy; consolidating
 * the three into one shared primitive is a worthwhile follow-up chore, kept out
 * of this UI-only, single-cluster PR to hold its blast radius to /account.)
 */
export function SectionPanel({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const headingId = `account-${title.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <Card>
      <CardContent
        role="group"
        aria-labelledby={headingId}
        className="flex flex-col gap-4"
      >
        <div className="flex items-start gap-3">
          <span className="bg-accent text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
            <Icon className="size-5" aria-hidden />
          </span>
          <div className="flex flex-col gap-0.5">
            <h2
              id={headingId}
              className="text-base font-semibold tracking-tight"
            >
              {title}
            </h2>
            {description ? (
              <p className="text-muted-foreground text-sm">{description}</p>
            ) : null}
          </div>
        </div>
        {children}
      </CardContent>
    </Card>
  );
}
