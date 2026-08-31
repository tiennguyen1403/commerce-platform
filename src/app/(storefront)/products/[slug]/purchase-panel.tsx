"use client";

import { useState } from "react";
import { Check, Info, ShoppingCart } from "lucide-react";
import { formatMoney } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type PurchaseVariant = {
  id: string;
  name: string;
  priceCents: number;
  currency: string;
  stock: number;
};

/** Below this many units we nudge the shopper with an exact count. */
const LOW_STOCK_THRESHOLD = 5;

/**
 * PDP purchase controls: pick a variant, see its live price and stock, add to
 * cart. The cart itself is cookie-backed and lands in #12 — until then the CTA
 * is a working control that confirms the action is wired but has nowhere to go
 * yet (swap the click handler for the `addToCart` Server Action in #12).
 */
export function PurchasePanel({ variants }: { variants: PurchaseVariant[] }) {
  // Default to the first in-stock variant so the CTA is actionable on load;
  // fall back to the first variant when the whole product is sold out.
  const firstSelectable = variants.find((v) => v.stock > 0) ?? variants[0];
  const [selectedId, setSelectedId] = useState(firstSelectable?.id);
  const [added, setAdded] = useState(false);

  const selected = variants.find((v) => v.id === selectedId) ?? firstSelectable;
  // A product always ships with at least one variant (zod-enforced on write).
  if (!selected) return null;

  const soldOut = selected.stock <= 0;
  const lowStock = !soldOut && selected.stock <= LOW_STOCK_THRESHOLD;
  const hasChoice = variants.length > 1;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2" aria-live="polite">
        <p className="text-2xl font-semibold tracking-tight tabular-nums">
          {formatMoney(selected.priceCents, selected.currency)}
        </p>
        {soldOut ? (
          <Badge variant="secondary" className="w-fit">
            Sold out
          </Badge>
        ) : lowStock ? (
          <span className="text-sm font-medium">
            Only {selected.stock} left
          </span>
        ) : (
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-sm">
            <Check className="size-4" />
            In stock
          </span>
        )}
      </div>

      {hasChoice ? (
        <div className="flex flex-col gap-2">
          <label htmlFor="variant" className="text-sm font-medium">
            Variant
          </label>
          <Select
            value={selected.id}
            onValueChange={(value) => {
              if (value) {
                setSelectedId(value);
                setAdded(false);
              }
            }}
          >
            <SelectTrigger id="variant" className="w-full sm:w-72">
              <SelectValue>
                {(value) => variants.find((v) => v.id === value)?.name}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {variants.map((v) => (
                <SelectItem key={v.id} value={v.id} disabled={v.stock <= 0}>
                  {v.stock <= 0 ? `${v.name} — sold out` : v.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">{selected.name}</p>
      )}

      <div className="flex flex-col gap-2">
        <Button
          type="button"
          size="lg"
          disabled={soldOut}
          onClick={() => setAdded(true)}
          className="w-full sm:w-auto"
        >
          <ShoppingCart />
          {soldOut ? "Sold out" : "Add to cart"}
        </Button>
        {added && !soldOut ? (
          <p
            role="status"
            className="text-muted-foreground inline-flex items-center gap-1.5 text-sm"
          >
            <Info className="size-4" />
            Cart and checkout are coming soon.
          </p>
        ) : null}
      </div>
    </div>
  );
}
