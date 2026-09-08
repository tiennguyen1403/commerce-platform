import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { Globe, ImageIcon, ShieldCheck, Truck } from "lucide-react";
import { getStoreTenant } from "@/server/store-context";
import { catalogService } from "@/server/services/catalog.service";
import { availableUnits } from "@/lib/inventory";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { PurchasePanel } from "./purchase-panel";
import { ProductGallery } from "./product-gallery";

/**
 * Resolve an ACTIVE product for the public store. A missing slug, or a product
 * that is DRAFT/ARCHIVED, reads as "not here" — the storefront must never leak
 * hidden catalog. `cache()` dedupes the read so `generateMetadata` and the page
 * share one query per request.
 */
const getActiveProduct = cache(async (slug: string) => {
  const { tenantId } = await getStoreTenant();
  const product = await catalogService.getProductBySlug(tenantId, slug);
  if (!product || product.status !== "ACTIVE") return null;
  return product;
});

// Explicit inline Promise type, not the generated `PageProps` — those types
// don't exist when `tsc --noEmit` runs before `next build` in CI.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const product = await getActiveProduct(slug);
  if (!product) return { title: "Product not found" };

  const description =
    product.description ?? `${product.title}, available now at our shop.`;
  return { title: product.title, description };
}

/**
 * The PDP, laid out to the frozen PDP v2 canvas ("Final · A layout + B gallery",
 * Direction A): the gallery in a 7-column and the buy column in a 5-column
 * share of the grid from `md`, the buy column pinned from `lg` with the cart
 * page's own sticky recipe (`items-start` on the grid, `sticky top-6` on the
 * child — the header is static, so no offset). Only what the catalog holds is
 * drawn: the canvas's ratings, reviews, colour swatches, delivery estimate,
 * accordions and related rail are preview content with no data behind them
 * (GOAL.md → Out of scope).
 */
export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const product = await getActiveProduct(slug);
  if (!product) notFound();

  // Store currency — cached, since getActiveProduct already resolved the tenant.
  const { currency } = await getStoreTenant();

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-12 md:px-6 lg:gap-10 lg:py-16">
      {/* Breadcrumb (replaces the old back link). */}
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link href="/products" />}>
              All products
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem className="min-w-0">
            <BreadcrumbPage>{product.title}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="grid grid-cols-1 gap-8 md:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] md:items-start md:gap-10 lg:gap-12">
        {/* Gallery: the 4:5 cover + rail + viewer when the product has images,
              else the placeholder frame (image-less products stay fully
              server-rendered, and expose no product-named <img>). */}
        {product.images.length > 0 ? (
          <ProductGallery
            // Keyed by product so a client-side hop to another PDP remounts the
            // gallery: its active-slide and viewer state must never carry over.
            key={product.id}
            images={product.images.map((image) => ({
              id: image.id,
              url: image.url,
              altText: image.altText,
              // Display-only intrinsic size for the viewer's slides (M7 GOAL.md
              // → Exceptions 2); read from the same query, no widening.
              width: image.width,
              height: image.height,
            }))}
            productTitle={product.title}
          />
        ) : (
          <div className="border-border bg-muted flex aspect-4/5 items-center justify-center rounded-xl border">
            <ImageIcon
              className="text-muted-foreground/40 size-16"
              aria-hidden
            />
          </div>
        )}

        {/* Buy column. */}
        <div className="flex flex-col gap-6 lg:sticky lg:top-6">
          <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
            {product.title}
          </h1>

          <PurchasePanel
            currency={currency}
            productTitle={product.title}
            variants={product.variants.map((v) => ({
              id: v.id,
              name: v.name,
              priceCents: v.priceCents,
              available: availableUnits(v),
            }))}
          />

          {/* Honest, store-level info — static copy, no per-product data. */}
          <ul className="text-muted-foreground flex flex-col gap-2.5 text-sm">
            <li className="flex items-start gap-2.5">
              <Truck className="mt-0.5 size-4 shrink-0" aria-hidden />
              Made to order by our print partner
            </li>
            <li className="flex items-start gap-2.5">
              <Globe className="mt-0.5 size-4 shrink-0" aria-hidden />
              Ships to the US
            </li>
            <li className="flex items-start gap-2.5">
              <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
              Secure checkout with Stripe
            </li>
          </ul>

          {product.description ? (
            <>
              <div className="bg-border h-px" />
              <div className="flex flex-col gap-2">
                <h2 className="text-base font-semibold tracking-tight">
                  Details
                </h2>
                <p className="text-muted-foreground max-w-prose text-sm leading-7 text-pretty">
                  {product.description}
                </p>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
