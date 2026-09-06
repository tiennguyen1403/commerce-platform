import type { Metadata } from "next";
import { Suspense } from "react";
import { PackageX } from "lucide-react";
import { getStoreTenant } from "@/server/store-context";
import { catalogService } from "@/server/services/catalog.service";
import { Card, CardContent } from "@/components/ui/card";
import { ProductCard } from "./product-card";
import { ProductGridSkeleton } from "./product-grid-skeleton";

// The listing has no dynamic segment, so Next would prerender it at build and
// run the Prisma read against a DB that CI doesn't provide. Force dynamic
// rendering so the catalog is always read at request time (SSR).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Products",
  description: "Browse the full catalog.",
};

/** Reads and renders the catalog. Split out so the list can stream a skeleton
 *  via <Suspense> without a route-level loading.tsx (which would also wrap the
 *  PDP and break its 404 — see product-grid-skeleton.tsx). */
async function ProductGrid() {
  const { tenantId, currency } = await getStoreTenant();
  const products = await catalogService.getStorefrontProducts(tenantId);

  if (products.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-5 py-16 text-center">
          <span className="bg-muted text-muted-foreground flex size-14 items-center justify-center rounded-full">
            <PackageX className="size-7" aria-hidden />
          </span>
          <div className="flex flex-col gap-1">
            <p className="font-medium">No products yet</p>
            <p className="text-muted-foreground text-sm">
              Check back soon — the shop is being stocked.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Result count. A sort/filter affordance would sit on the right, but any
          control that reorders/narrows the grid would change the query — out of
          scope for this UI-only pass, so the slot stays reserved for later. */}
      <div className="border-border flex items-center justify-between border-b pb-4 text-sm">
        <p className="text-muted-foreground tabular-nums">
          {products.length} {products.length === 1 ? "product" : "products"}
        </p>
      </div>

      <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {products.map((product, index) => (
          <li key={product.id}>
            <ProductCard
              product={product}
              currency={currency}
              preload={index === 0}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function ProductsPage() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">Products</h1>
        <p className="text-muted-foreground">
          Everything in the shop, ready to ship.
        </p>
      </header>

      <Suspense fallback={<ProductGridSkeleton />}>
        <ProductGrid />
      </Suspense>
    </div>
  );
}
