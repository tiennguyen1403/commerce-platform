import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { ImageIcon } from "lucide-react";
import { formatMoney } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type StorefrontProduct = Prisma.ProductGetPayload<{
  include: { variants: true };
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
}: {
  product: StorefrontProduct;
  currency: string;
}) {
  const inStock = product.variants.some((v) => v.stock > 0);

  return (
    <Link
      href={`/products/${product.slug}`}
      className="group focus-visible:ring-ring/50 block rounded-xl focus-visible:ring-3 focus-visible:outline-none"
    >
      <Card className="group-hover:ring-foreground/25 h-full gap-0 py-0 transition-all group-hover:shadow-sm motion-safe:group-hover:-translate-y-0.5">
        <div className="bg-muted relative flex aspect-square items-center justify-center">
          <ImageIcon className="text-muted-foreground/40 size-10" />
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
