"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Check, Info, Loader2, ShoppingCart } from "lucide-react";
import { formatMoney } from "@/lib/utils";
import { LOW_STOCK_THRESHOLD } from "@/config/constants";
import { addToCartAction } from "@/app/(storefront)/cart/actions";
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
  /** Sellable units (`stock - reserved`) — drives the sold-out/low-stock UI. */
  available: number;
};

/**
 * PDP purchase controls: pick a variant, see its live price and stock, add it to
 * the cookie-backed cart via the `addToCart` Server Action. Each click adds one
 * unit; quantity is edited on the cart page. The action re-checks the variant and
 * clamps to live stock server-side, so this panel just fires it and reflects the
 * result.
 */
export function PurchasePanel({
  variants,
  currency,
}: {
  variants: PurchaseVariant[];
  currency: string;
}) {
  // Default to the first in-stock variant so the CTA is actionable on load;
  // fall back to the first variant when the whole product is sold out.
  const firstSelectable = variants.find((v) => v.available > 0) ?? variants[0];
  const [selectedId, setSelectedId] = useState(firstSelectable?.id);
  const [status, setStatus] = useState<"idle" | "added" | "error">("idle");
  const [isPending, startTransition] = useTransition();

  const selected = variants.find((v) => v.id === selectedId) ?? firstSelectable;
  // A product always ships with at least one variant (zod-enforced on write).
  if (!selected) return null;

  const soldOut = selected.available <= 0;
  const lowStock = !soldOut && selected.available <= LOW_STOCK_THRESHOLD;
  const hasChoice = variants.length > 1;

  function addToCart() {
    if (!selected) return;
    const variantId = selected.id;
    setStatus("idle");
    startTransition(async () => {
      const result = await addToCartAction(variantId);
      setStatus(result.ok ? "added" : "error");
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2" aria-live="polite">
        <p className="text-2xl font-semibold tracking-tight tabular-nums">
          {formatMoney(selected.priceCents, currency)}
        </p>
        {soldOut ? (
          <Badge variant="secondary" className="w-fit">
            Sold out
          </Badge>
        ) : lowStock ? (
          <span className="text-sm font-medium">
            Only {selected.available} left
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
                setStatus("idle");
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
                <SelectItem key={v.id} value={v.id} disabled={v.available <= 0}>
                  {v.available <= 0 ? `${v.name} — sold out` : v.name}
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
          disabled={soldOut || isPending}
          onClick={addToCart}
          className="w-full sm:w-auto"
        >
          {isPending ? <Loader2 className="animate-spin" /> : <ShoppingCart />}
          {soldOut ? "Sold out" : isPending ? "Adding…" : "Add to cart"}
        </Button>
        {status === "added" && !soldOut ? (
          <p
            role="status"
            className="text-muted-foreground inline-flex items-center gap-1.5 text-sm"
          >
            <Check className="size-4" />
            Added to cart ·{" "}
            <Link
              href="/cart"
              className="text-foreground font-medium underline underline-offset-4"
            >
              View cart
            </Link>
          </p>
        ) : status === "error" ? (
          <p
            role="alert"
            className="text-destructive inline-flex items-center gap-1.5 text-sm"
          >
            <Info className="size-4" />
            Couldn&apos;t add to cart. Please try again.
          </p>
        ) : null}
      </div>
    </div>
  );
}
