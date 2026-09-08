import type { Prisma } from "@prisma/client";
import { availableUnits } from "@/lib/inventory";
import { Card } from "@/components/ui/card";
import { ProductCardMedia } from "./product-card-media";
import {
  inEntryOrder,
  lowStockLabel,
  priceLabel,
  variantsLabel,
} from "./product-card-labels";

type StorefrontProduct = Prisma.ProductGetPayload<{
  include: { variants: true; images: true };
}>;

/**
 * Product card v2 (M7-05, the brief agreed on #238): the square image well (V10)
 * now a mini slider over every image, then title, price, and a muted meta line
 * built from the variants — what the variants offer ("3 sizes · Small–Large",
 * "One size") and a low-stock cue ("Only 4 left") — all from the rows the
 * listing query already loads. Shared by the listing and search results.
 *
 * A Server Component: the labels are computed here and the body is passed into
 * `ProductCardMedia`, the one client island, which renders the link around the
 * image and this body (the link-wraps-image anatomy the product-images E2E keys
 * on) with the slider controls beside it. Hover lifts the card (V9: `shadow-sm`
 * + the ring, `motion-safe`); the link's focus ring is drawn by the card, since
 * the card clips its own overflow.
 */
export function ProductCard({
  product,
  currency,
  preload = false,
}: {
  product: StorefrontProduct;
  currency: string;
  /** Mark this card's first image as an LCP preload — set on the first card in a grid. */
  preload?: boolean;
}) {
  const variants = inEntryOrder(product.variants);
  const inStock = variants.some((v) => availableUnits(v) > 0);
  const offer = variantsLabel(variants);
  const lowStock = lowStockLabel(variants);

  return (
    <Card className="hover:ring-foreground/25 has-[a:focus-visible]:ring-ring/50 h-full gap-0 py-0 transition-all hover:shadow-sm has-[a:focus-visible]:ring-3 motion-safe:hover:-translate-y-0.5">
      <ProductCardMedia
        href={`/products/${product.slug}`}
        images={product.images.map(({ id, url, altText }) => ({
          id,
          url,
          altText,
        }))}
        productTitle={product.title}
        preload={preload}
        soldOut={!inStock}
      >
        <div className="flex flex-col gap-1 p-4">
          <h2 className="truncate text-base font-medium" title={product.title}>
            {product.title}
          </h2>
          <p className="text-sm tabular-nums">
            {priceLabel(variants, currency)}
          </p>
          {offer || lowStock ? (
            <p className="text-muted-foreground text-sm">
              {offer}
              {offer && lowStock ? " · " : null}
              {lowStock ? (
                <span className="whitespace-nowrap tabular-nums">
                  {lowStock}
                </span>
              ) : null}
            </p>
          ) : null}
        </div>
      </ProductCardMedia>
    </Card>
  );
}
