import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { formatMoney } from "@/lib/utils";
import { availableUnits } from "@/lib/inventory";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ProductImageFrame } from "./product-image";

type StorefrontProduct = Prisma.ProductGetPayload<{
  include: { variants: true; images: true };
}>;

/** Entry price for a card: a flat price when every variant matches, otherwise
 *  "From <cheapest>" so the grid stays scannable without a full range. */
function priceLabel(
  variants: { priceCents: number }[],
  currency: string,
): string {
  if (variants.length === 0) return "—";
  const prices = variants.map((v) => v.priceCents);
  const min = Math.min(...prices);
  return prices.every((p) => p === min)
    ? formatMoney(min, currency)
    : `From ${formatMoney(min, currency)}`;
}

export function ProductCard({
  product,
  currency,
  preload = false,
}: {
  product: StorefrontProduct;
  currency: string;
  /** Mark this card's image as an LCP preload — set on the first card in a grid. */
  preload?: boolean;
}) {
  const inStock = product.variants.some((v) => availableUnits(v) > 0);

  return (
    <Link
      href={`/products/${product.slug}`}
      className="group focus-visible:ring-ring/50 block rounded-xl focus-visible:ring-3 focus-visible:outline-none"
    >
      <Card className="group-hover:ring-foreground/25 h-full gap-0 py-0 transition-all group-hover:shadow-sm motion-safe:group-hover:-translate-y-0.5">
        <div className="bg-muted relative flex aspect-square items-center justify-center">
          <ProductImageFrame
            image={product.images[0]}
            productTitle={product.title}
            sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
            preload={preload}
            iconClassName="size-10"
          />
          {!inStock ? (
            <Badge variant="secondary" className="absolute top-3 left-3">
              Sold out
            </Badge>
          ) : null}
        </div>
        <div className="flex flex-col gap-1 p-4">
          <h2 className="truncate font-medium" title={product.title}>
            {product.title}
          </h2>
          <p className="text-muted-foreground text-sm tabular-nums">
            {priceLabel(product.variants, currency)}
          </p>
        </div>
      </Card>
    </Link>
  );
}
