import { Globe, LogIn, Menu, ShoppingCart, Store } from "lucide-react";

import { DEFAULT_THEME_HUE, scopedThemeCss } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * The landing hero's illustration: two storefront windows, each on its own
 * subdomain and accent — "one codebase, many stores" drawn from the shipped
 * storefront chrome (`(storefront)/layout.tsx`, `StoreBrand`) and product card.
 *
 * Static by design. The two stores, their catalogs and prices mirror the seed
 * (`prisma/seed.ts`: Demo Store on the platform hue, Aurora on 285°), but nothing
 * here is read from the DB — the apex page has no tenant context (#215's
 * UI-only rule). Product tiles are gradients because the seed images are.
 *
 * Each window re-parametrizes the accent tokens for its own subtree with the
 * exact recipe the storefront ships (`scopedThemeCss`), so plain `bg-accent` /
 * `text-primary` inside it render that store's accent in light and dark alike.
 * `example.com` stands in for the app domain.
 */

/** The seeded second store's hue (`AURORA_HUE` in `prisma/seed.ts`). */
const AURORA_HUE = 285;

type StoreWindowSpec = {
  id: "demo" | "aurora";
  name: string;
  /** What the store's listing counts — ACTIVE products only, never drafts. */
  count: number;
  products: ReadonlyArray<{ title: string; price: string }>;
};

const DEMO: StoreWindowSpec = {
  id: "demo",
  name: "Demo Store",
  count: 4,
  products: [
    { title: "Classic Tee", price: "From $19.99" },
    { title: "Everyday Hoodie", price: "From $49.00" },
    { title: "Canvas Tote Bag", price: "$25.00" },
  ],
};

const AURORA: StoreWindowSpec = {
  id: "aurora",
  name: "Aurora",
  count: 3,
  products: [
    { title: "Aurora Candle", price: "$24.00" },
    { title: "Midnight Mug", price: "$18.00" },
    { title: "Borealis Tee", price: "From $26.00" },
  ],
};

const STAGE_CSS = [
  scopedThemeCss('[data-store-window="demo"]', DEFAULT_THEME_HUE),
  scopedThemeCss('[data-store-window="aurora"]', AURORA_HUE),
].join("\n");

export function LandingStage() {
  return (
    <div className="bg-accent relative max-w-[568px] overflow-hidden rounded-2xl p-4 sm:p-6 lg:max-w-none">
      <style dangerouslySetInnerHTML={{ __html: STAGE_CSS }} />
      <div
        role="img"
        aria-label="Two storefronts on the platform, Demo Store and Aurora, each on its own subdomain with its own accent"
        className="relative pt-7 sm:pt-11"
      >
        {/* Aurora sits behind and to the left, so its brand tile and name show
            beside the front window: the second store's accent at a glance. */}
        <div className="absolute top-0 left-0 w-[calc(100%-2.5rem)] sm:w-[420px]">
          <StoreWindow store={AURORA} back />
        </div>
        <div className="relative pl-10 sm:pl-[100px]">
          <StoreWindow store={DEMO} className="w-full sm:w-[420px]" />
        </div>
      </div>
    </div>
  );
}

/**
 * One storefront window: a url strip, the store header (the mobile row below
 * `sm`, the desktop row from it — the real chrome's two rows, scaled down; the
 * miniature switches at `sm` rather than the chrome's `md` because that is
 * where its 420px desktop width first fits the 568px stage), the count
 * toolbar, and the product grid (two tiles on the mobile row, three from `sm`).
 *
 * `back` marks the window that sits behind the other: only its left edge stays
 * visible, so the header's nav and utilities — which would be cut mid-word by
 * the front window — are omitted there.
 */
function StoreWindow({
  store,
  back = false,
  className,
}: {
  store: StoreWindowSpec;
  back?: boolean;
  className?: string;
}) {
  return (
    <div
      data-store-window={store.id}
      className={cn(
        "bg-card text-card-foreground ring-foreground/10 overflow-hidden rounded-xl text-xs shadow-lg ring-1",
        className,
      )}
    >
      <div className="bg-muted text-muted-foreground flex h-7 items-center gap-2 border-b px-3 whitespace-nowrap">
        <Globe className="size-3 shrink-0" />
        <span>
          <span className="text-foreground font-medium">{store.id}</span>
          .example.com/products
        </span>
      </div>

      <div className="flex h-11 items-center gap-2 border-b px-3.5 sm:gap-3">
        <Menu className="size-4 shrink-0 sm:hidden" />
        <span className="flex items-center gap-2 font-semibold tracking-tight whitespace-nowrap">
          <span className="bg-accent text-primary flex size-[22px] shrink-0 items-center justify-center rounded-md">
            <Store className="size-3.5" />
          </span>
          {store.name}
        </span>
        {back ? null : (
          <>
            <span className="hidden font-medium sm:inline">Products</span>
            <span className="ml-auto hidden items-center gap-1.5 sm:flex">
              <span className="border-input text-muted-foreground flex h-6 w-18 items-center rounded-md border px-2">
                Search…
              </span>
              <span className="flex h-6 items-center gap-1 rounded-md border px-2 font-medium whitespace-nowrap">
                <ShoppingCart className="size-3" />
                Cart
              </span>
              <span className="flex h-6 items-center gap-1 px-1 font-medium whitespace-nowrap">
                <LogIn className="size-3" />
                Sign in
              </span>
            </span>
            <ShoppingCart className="ml-auto size-4 shrink-0 sm:hidden" />
          </>
        )}
      </div>

      <div className="p-3.5">
        <div className="mb-2.5 flex items-baseline justify-between gap-2">
          <span className="font-semibold tracking-tight">All products</span>
          <span className="text-muted-foreground">{store.count} products</span>
        </div>
        <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {store.products.map((product, index) => (
            <li
              key={product.title}
              className={cn(
                "flex min-w-0 flex-col gap-1.5",
                index === 2 && "max-sm:hidden",
              )}
            >
              <div className="from-accent to-muted border-foreground/10 aspect-square rounded-md border bg-linear-150 to-75%" />
              <p className="truncate font-medium">{product.title}</p>
              <p className="text-muted-foreground tabular-nums">
                {product.price}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
