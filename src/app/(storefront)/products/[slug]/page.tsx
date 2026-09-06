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
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-6 py-10">
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

      <div className="grid grid-cols-1 gap-8 md:grid-cols-2 md:gap-12">
        {/* Gallery: a real main image + thumbnail rail when the product has images,
            else the placeholder frame (image-less products stay fully server-rendered). */}
        {product.images.length > 0 ? (
          <ProductGallery
            images={product.images.map((image) => ({
              id: image.id,
              url: image.url,
              altText: image.altText,
            }))}
            productTitle={product.title}
          />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="border-border bg-muted flex aspect-square items-center justify-center rounded-xl border">
              <ImageIcon
                className="text-muted-foreground/40 size-16"
                aria-hidden
              />
            </div>
          </div>
        )}

        {/* Info column. */}
        <div className="flex flex-col gap-6">
          <h1 className="text-3xl font-semibold tracking-tight">
            {product.title}
          </h1>

          <PurchasePanel
            currency={currency}
            variants={product.variants.map((v) => ({
              id: v.id,
              name: v.name,
              priceCents: v.priceCents,
              available: availableUnits(v),
            }))}
          />

          {/* Honest, store-level info — static copy, no per-product data. */}
          <ul className="text-muted-foreground flex flex-col gap-2.5 text-sm">
            <li className="flex items-center gap-2.5">
              <Truck className="size-4 shrink-0" aria-hidden />
              Made to order by our print partner
            </li>
            <li className="flex items-center gap-2.5">
              <Globe className="size-4 shrink-0" aria-hidden />
              Ships to the US
            </li>
            <li className="flex items-center gap-2.5">
              <ShieldCheck className="size-4 shrink-0" aria-hidden />
              Secure checkout with Stripe
            </li>
          </ul>

          {product.description ? (
            <>
              <div className="bg-border h-px" />
              <div className="flex flex-col gap-2">
                <h2 className="text-sm font-medium">Details</h2>
                <p className="text-muted-foreground max-w-prose text-sm leading-7">
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
