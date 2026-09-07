"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Loader2, Minus, Plus, Trash2 } from "lucide-react";
import { cn, formatMoney } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { MAX_CART_QTY, type CartItem } from "@/lib/cart";
import { ProductImageFrame } from "../products/product-image";
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

  const atMax = item.qty >= Math.min(item.available, MAX_CART_QTY);

  return (
    <div
      className={cn(
        "flex items-start gap-4 px-4 py-4 transition-opacity",
        isPending && "opacity-60",
      )}
      aria-busy={isPending}
    >
      {/* Thumbnail → PDP. The product-title link below already names the target,
          so this one is hidden from AT and taken out of the tab order to avoid a
          redundant stop. The frame owns the square; ProductImageFrame fills it
          (or shows the placeholder icon when the product has no image). */}
      <Link
        href={`/products/${item.productSlug}`}
        aria-hidden
        tabIndex={-1}
        className="bg-muted relative flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border sm:size-20"
      >
        <ProductImageFrame
          image={item.image}
          productTitle={item.productTitle}
          sizes="80px"
          iconClassName="size-6"
        />
      </Link>

      <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Link
            href={`/products/${item.productSlug}`}
            className="font-medium tracking-tight underline-offset-4 hover:underline"
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

        <div className="flex items-center gap-3 sm:gap-4">
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

          <div className="ml-auto flex items-center gap-1 sm:gap-3">
            <span className="w-24 text-right text-sm font-semibold tabular-nums">
              {formatMoney(item.lineTotalCents, item.currency)}
            </span>
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
        </div>
      </div>
    </div>
  );
}
