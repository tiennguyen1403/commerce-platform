import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ProductForm, type ProductFormValues } from "../product-form";

export const metadata: Metadata = { title: "New product" };

const EMPTY_PRODUCT: ProductFormValues = {
  title: "",
  slug: "",
  description: "",
  status: "DRAFT",
  variants: [{ sku: "", name: "", price: "", currency: "usd", stock: "0" }],
};

export default function NewProductPage() {
  // The /admin layout already gates access and resolves the tenant.
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-10">
      <div className="flex flex-col gap-2">
        <Link
          href="/admin/products"
          className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-sm font-medium"
        >
          <ArrowLeft className="size-4" />
          Back to products
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">New product</h1>
      </div>
      <ProductForm mode="create" initialValues={EMPTY_PRODUCT} />
    </div>
  );
}
