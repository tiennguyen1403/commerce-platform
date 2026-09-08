"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Check, Info, Loader2, Minus, Plus, ShoppingCart } from "lucide-react";
import { cn, formatMoney } from "@/lib/utils";
import { LOW_STOCK_THRESHOLD } from "@/config/constants";
import { MAX_CART_QTY } from "@/lib/cart";
import { addToCartAction } from "@/app/(storefront)/cart/actions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export type PurchaseVariant = {
  id: string;
  name: string;
  priceCents: number;
  /** Sellable units (`stock - reserved`) — drives the sold-out/low-stock UI. */
  available: number;
};

// The mobile buy bar's own height, in CSS px: a 1px top border, `pt-3`, the 44px
// CTA and `pb-[max(1rem, …)]` = 73, rounded up. The bar steps aside while the
// viewport's bottom edge is within this distance of the document's end — the one
// band it would otherwise cover for good (the footer's last line).
const BUY_BAR_CLEARANCE = 80;

// Below Tailwind's `md` breakpoint (48rem), the only place the mobile buy bar
// exists: the exact complement of the `md:` media query.
const BELOW_MD = "not all and (min-width: 48rem)";

// One stepper button: fills the 48px group, square inner edge, rounded outer
// edge (the group's radius minus its border). `aria-disabled` (not `disabled`)
// is what `focusableWhenDisabled` renders, so the dimming is spelled out here;
// the raised z-index keeps the focus ring above the neighbouring readout.
const stepperButton =
  "relative h-full w-10 rounded-none px-0 focus-visible:z-10 aria-disabled:pointer-events-none aria-disabled:opacity-50";

// The CTAs while an add is in flight: `focusableWhenDisabled` again, so the
// same `aria-disabled` dimming as the stepper.
const ctaPending = "aria-disabled:pointer-events-none aria-disabled:opacity-50";

/**
 * PDP purchase controls: pick a variant, see its live price and stock, choose a
 * quantity and add it to the cookie-backed cart via the `addToCart` Server
 * Action. The stepper only feeds the action's existing optional `qty` argument
 * (M7 GOAL.md → Exceptions 1): "add" is an increment server-side and the service
 * clamps the line to live stock, so the ceiling drawn here — `min(available, 99)`,
 * the cart page's own rule — is UX, not enforcement.
 *
 * Also owns the mobile sticky buy bar of the frozen PDP v2 canvas ("Mobile ·
 * scrolled"): below `md`, once the add-to-cart row has scrolled up out of view,
 * a compact bar with the title, price and a 44px CTA sits at the bottom of the
 * viewport (see the effect below for the rules that show and hide it).
 */
export function PurchasePanel({
  variants,
  currency,
  productTitle,
}: {
  variants: PurchaseVariant[];
  currency: string;
  /** Display-only: names the product in the mobile buy bar. */
  productTitle: string;
}) {
  // Default to the first in-stock variant so the CTA is actionable on load;
  // fall back to the first variant when the whole product is sold out.
  const firstSelectable = variants.find((v) => v.available > 0) ?? variants[0];
  const [selectedId, setSelectedId] = useState(firstSelectable?.id);
  const [requestedQty, setRequestedQty] = useState(1);
  const [status, setStatus] = useState<"idle" | "added" | "error">("idle");
  const [isPending, startTransition] = useTransition();
  const [barVisible, setBarVisible] = useState(false);
  const ctaRowRef = useRef<HTMLDivElement>(null);

  // The mobile buy bar shows while the add-to-cart row sits *above* the
  // viewport (scrolled past — not merely below the fold on load), except within
  // the last BUY_BAR_CLEARANCE px of the document, where it would sit over the
  // end of the footer. It is mounted only then: a bar parked off-screen with a
  // transform or `opacity-0` would still put a second "Add to cart" button into
  // the accessibility tree (research Risk #1a), and the media query keeps it out
  // of the DOM on desktop altogether — `md:hidden` on the bar is the CSS belt to
  // these JS braces. Both rules are read in one frame-throttled scroll listener
  // rather than an IntersectionObserver: the distance to the document's end has
  // no observable target (it lies past this page's markup), and an observer
  // misses the row when a jump or a fast fling carries it across the viewport
  // between two frames — its intersection state never changes.
  useEffect(() => {
    const row = ctaRowRef.current;
    if (!row || typeof window.matchMedia !== "function") return;
    const phone = window.matchMedia(BELOW_MD);
    let frame = 0;

    const update = () => {
      frame = 0;
      const rowAbove = row.getBoundingClientRect().bottom <= 0;
      const remaining =
        document.documentElement.scrollHeight -
        (window.scrollY + window.innerHeight);
      setBarVisible(rowAbove && remaining >= BUY_BAR_CLEARANCE);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const stop = () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };
    const sync = () => {
      stop();
      if (!phone.matches) {
        setBarVisible(false);
        return;
      }
      window.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", onScroll, { passive: true });
      update();
    };

    sync();
    phone.addEventListener("change", sync);
    return () => {
      phone.removeEventListener("change", sync);
      stop();
    };
  }, []);

  const selected = variants.find((v) => v.id === selectedId) ?? firstSelectable;
  // A product always ships with at least one variant (zod-enforced on write).
  if (!selected) return null;

  const soldOut = selected.available <= 0;
  const lowStock = !soldOut && selected.available <= LOW_STOCK_THRESHOLD;
  const hasChoice = variants.length > 1;
  // The stepper's ceiling (see above) — never below 1, so a sold-out variant
  // still reads "1" in its disabled stepper.
  const maxQty = Math.max(1, Math.min(selected.available, MAX_CART_QTY));
  // Clamped rather than reset when the shopper switches to a variant with less
  // stock than the quantity they had picked.
  const qty = Math.min(requestedQty, maxQty);
  const price = formatMoney(selected.priceCents, currency);

  function setQty(next: number) {
    setStatus("idle");
    setRequestedQty(Math.min(maxQty, Math.max(1, next)));
  }

  function addToCart() {
    if (!selected) return;
    const variantId = selected.id;
    const quantity = qty;
    setStatus("idle");
    startTransition(async () => {
      const result = await addToCartAction(variantId, quantity);
      setStatus(result.ok ? "added" : "error");
    });
  }

  const ctaIcon = isPending ? (
    <Loader2 className="animate-spin" />
  ) : (
    <ShoppingCart />
  );
  const ctaLabel = soldOut ? "Sold out" : isPending ? "Adding…" : "Add to cart";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2" aria-live="polite">
        <p className="text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl">
          {price}
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
            <Check className="text-accent-foreground size-4" />
            In stock
          </span>
        )}
      </div>

      {hasChoice ? (
        <div className="flex flex-col gap-2.5">
          <span className="text-sm font-medium">Variant</span>
          <div
            className="flex flex-wrap gap-2"
            role="radiogroup"
            aria-label="Variant"
          >
            {variants.map((v) => {
              const isSelected = v.id === selected.id;
              const isOff = v.available <= 0;
              return (
                <button
                  key={v.id}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  disabled={isOff}
                  onClick={() => {
                    setSelectedId(v.id);
                    setStatus("idle");
                  }}
                  className={cn(
                    "focus-visible:ring-ring/50 inline-flex h-10 items-center justify-center rounded-lg border px-4 text-sm font-medium transition-colors focus-visible:ring-3 focus-visible:outline-none",
                    isOff &&
                      "text-muted-foreground cursor-not-allowed line-through opacity-60",
                    !isOff &&
                      isSelected &&
                      "border-primary bg-accent text-accent-foreground font-semibold",
                    !isOff &&
                      !isSelected &&
                      "border-border hover:border-foreground/30",
                  )}
                >
                  {v.name}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">{selected.name}</p>
      )}

      <div className="flex flex-col gap-2">
        {/* The canvas's row: a 48px bordered stepper beside the flex-1 CTA. The
            stepper is the cart row's idiom (`cart-items.tsx`) — two icon buttons
            named "Decrease quantity" / "Increase quantity" around a polite live
            readout — with `focusableWhenDisabled`, so a button that reaches its
            bound while focused keeps the focus instead of dropping it on <body>. */}
        <div ref={ctaRowRef} className="flex gap-2">
          <div
            role="group"
            aria-label="Quantity"
            className="border-border flex h-12 w-32 shrink-0 rounded-lg border"
          >
            <Button
              type="button"
              variant="ghost"
              aria-label="Decrease quantity"
              disabled={soldOut || isPending || qty <= 1}
              focusableWhenDisabled
              onClick={() => setQty(qty - 1)}
              className={cn(
                stepperButton,
                "rounded-l-[calc(var(--radius-lg)-1px)]",
              )}
            >
              <Minus />
            </Button>
            <span
              aria-live="polite"
              className="flex flex-1 items-center justify-center text-[15px] font-semibold tabular-nums"
            >
              {qty}
            </span>
            <Button
              type="button"
              variant="ghost"
              aria-label="Increase quantity"
              disabled={soldOut || isPending || qty >= maxQty}
              focusableWhenDisabled
              onClick={() => setQty(qty + 1)}
              className={cn(
                stepperButton,
                "rounded-r-[calc(var(--radius-lg)-1px)]",
              )}
            >
              <Plus />
            </Button>
          </div>
          {/* Pending keeps the focus (`aria-disabled`, like the stepper) so the
              status line lands next to it; sold out is a real `disabled` — a
              permanently dead control should not be a tab stop. */}
          <Button
            type="button"
            size="lg"
            disabled={soldOut || isPending}
            focusableWhenDisabled={!soldOut}
            onClick={addToCart}
            className={cn("h-12 flex-1 text-[15px] font-semibold", ctaPending)}
          >
            {ctaIcon}
            {ctaLabel}
          </Button>
        </div>
        {status === "added" && !soldOut ? (
          <p
            role="status"
            className="text-muted-foreground inline-flex items-center gap-1.5 text-sm"
          >
            <Check className="text-accent-foreground size-4" />
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

      {/* Mounted on reveal and unmounted on hide (see the effect): a shopper who
          tabbed into the bar and then scrolls the row back into view loses that
          focus to <body> — the price of keeping a hidden second "Add to cart"
          out of the accessibility tree. */}
      {barVisible && !soldOut ? (
        <div
          className={cn(
            // An edge-anchored bar (DESIGN.md V9): a border on the anchored edge,
            // translucent over the content scrolling beneath it.
            "bg-background/95 border-border fixed inset-x-0 bottom-0 z-40 border-t backdrop-blur md:hidden",
            // Gone — `display: none`, never a transform — while the fullscreen
            // viewer is open; the gallery stamps `data-viewer-open` on <html>
            // (`VIEWER_OPEN_ATTR`, product-gallery.tsx; research Risk #8).
            "[[data-viewer-open]_&]:hidden",
            "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom motion-safe:duration-200",
          )}
        >
          {/* `max(1rem, env(safe-area-inset-bottom))`: 1rem today (the root
              layout does not opt into `viewport-fit=cover`), the home-indicator
              inset for free if it ever does. */}
          <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-sm font-medium">
                {productTitle}
              </span>
              {status === "added" ? (
                <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <Check
                    className="text-accent-foreground size-3.5 shrink-0"
                    aria-hidden
                  />
                  Added to cart ·{" "}
                  <Link
                    href="/cart"
                    className="text-foreground font-medium underline underline-offset-4"
                  >
                    View cart
                  </Link>
                </span>
              ) : status === "error" ? (
                <span className="text-destructive text-xs">
                  Couldn&apos;t add to cart. Please try again.
                </span>
              ) : (
                <span className="text-muted-foreground truncate text-xs tabular-nums">
                  {price} · {selected.name}
                  {qty > 1 ? ` · Qty ${qty}` : null}
                </span>
              )}
            </div>
            <Button
              type="button"
              disabled={isPending}
              focusableWhenDisabled
              onClick={addToCart}
              className={cn(
                "h-11 shrink-0 px-4 text-[15px] font-semibold",
                ctaPending,
              )}
            >
              {ctaIcon}
              {ctaLabel}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
