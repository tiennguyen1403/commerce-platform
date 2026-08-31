import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { ArrowLeft, ImageIcon } from "lucide-react";
import { getStoreTenant } from "@/server/store-context";
import { catalogService } from "@/server/services/catalog.service";
import { PurchasePanel } from "./purchase-panel";

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
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
      <Link
        href="/products"
        className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-sm font-medium"
      >
        <ArrowLeft className="size-4" />
        All products
      </Link>

      <div className="grid grid-cols-1 gap-8 md:grid-cols-2 md:gap-12">
        <div className="bg-muted ring-foreground/10 flex aspect-square items-center justify-center rounded-xl ring-1">
          <ImageIcon className="text-muted-foreground/40 size-16" />
        </div>

        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <h1 className="text-3xl font-semibold tracking-tight">
              {product.title}
            </h1>
            {product.description ? (
              <p className="text-muted-foreground max-w-prose leading-7">
                {product.description}
              </p>
            ) : null}
          </div>

          <PurchasePanel
            currency={currency}
            variants={product.variants.map((v) => ({
              id: v.id,
              name: v.name,
              priceCents: v.priceCents,
              stock: v.stock,
            }))}
          />
        </div>
      </div>
    </div>
  );
}
