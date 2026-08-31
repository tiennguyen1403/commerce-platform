"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Loader2, Minus, Plus, Trash2 } from "lucide-react";
import { cn, formatMoney } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { MAX_CART_QTY, type CartItem } from "@/lib/cart";
import { removeFromCartAction, updateQtyAction } from "./actions";

/**
 * Editable cart line items. The server cart page prices and reconciles the cart,
 * then hands the finished `CartItem[]` here; this component only drives the
 * mutations. Each row owns its own transition so a pending update dims just that
 * line, and calls the cart Server Actions, which re-render the page (and the
 * header badge) with fresh, server-computed quantities and totals.
 */
export function CartItems({ items }: { items: CartItem[] }) {
  return (
    <ul className="divide-border divide-y rounded-xl border">
      {items.map((item) => (
        <li key={item.variantId}>
          <CartRow item={item} />
        </li>
      ))}
    </ul>
  );
}

function CartRow({ item }: { item: CartItem }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function setQty(qty: number) {
    setError(null);
    startTransition(async () => {
      const result = await updateQtyAction(item.variantId, qty);
      if (!result.ok) setError(result.error);
    });
  }

  function remove() {
    setError(null);
    startTransition(async () => {
      const result = await removeFromCartAction(item.variantId);
      if (!result.ok) setError(result.error);
    });
  }

  const atMax = item.qty >= Math.min(item.stock, MAX_CART_QTY);

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4 transition-opacity",
        isPending && "opacity-60",
      )}
      aria-busy={isPending}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Link
          href={`/products/${item.productSlug}`}
          className="hover:text-foreground font-medium tracking-tight"
        >
          {item.productTitle}
        </Link>
        <span className="text-muted-foreground text-sm">
          {item.variantName}
        </span>
        <span className="text-muted-foreground text-sm tabular-nums">
          {formatMoney(item.unitPriceCents, item.currency)} each
        </span>
        {error ? (
          <span role="alert" className="text-destructive text-sm">
            {error}
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => setQty(item.qty - 1)}
          disabled={isPending || item.qty <= 1}
          aria-label="Decrease quantity"
        >
          <Minus />
        </Button>
        <span
          className="w-9 text-center text-sm font-medium tabular-nums"
          aria-live="polite"
        >
          {isPending ? (
            <Loader2 className="mx-auto size-4 animate-spin" aria-hidden />
          ) : (
            item.qty
          )}
        </span>
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => setQty(item.qty + 1)}
          disabled={isPending || atMax}
          aria-label="Increase quantity"
        >
          <Plus />
        </Button>
      </div>

      <div className="w-24 text-right text-sm font-semibold tabular-nums">
        {formatMoney(item.lineTotalCents, item.currency)}
      </div>

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={remove}
        disabled={isPending}
        aria-label={`Remove ${item.productTitle}`}
        className="text-muted-foreground hover:text-destructive"
      >
        <Trash2 />
      </Button>
    </div>
  );
}
