import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireAdminContext } from "@/server/auth/admin-context";
import { catalogService } from "@/server/services/catalog.service";
import { ProductForm, type ProductFormValues } from "../product-form";
import { ArchiveProductButton } from "../archive-button";

export const metadata: Metadata = { title: "Edit product" };

export default async function EditProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { tenantId, currency } = await requireAdminContext();
  const { id } = await params;

  const product = await catalogService.getAdminProduct(tenantId, id);
  if (!product) notFound();

  const initialValues: ProductFormValues = {
    title: product.title,
    slug: product.slug,
    description: product.description ?? "",
    status: product.status,
    variants: product.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      name: v.name,
      price: (v.priceCents / 100).toFixed(2),
      stock: String(v.stock),
      // A variant already referenced by an order can't be deleted; the form
      // disables its Remove button so the admin never hits that dead-end.
      hasOrders: v._count.orderItems > 0,
    })),
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Link
            href="/admin/products"
            className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-sm font-medium"
          >
            <ArrowLeft className="size-4" />
            Back to products
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">
            Edit product
          </h1>
        </div>
        {product.status !== "ARCHIVED" ? (
          <ArchiveProductButton
            productId={product.id}
            productTitle={product.title}
          />
        ) : null}
      </div>
      <ProductForm
        mode="edit"
        productId={product.id}
        initialValues={initialValues}
        storeCurrency={currency}
      />
    </div>
  );
}
