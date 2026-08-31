import type { Metadata } from "next";
import Link from "next/link";
import { Package, Plus } from "lucide-react";
import { requireAdminContext } from "@/server/auth/admin-context";
import { catalogService } from "@/server/services/catalog.service";
import { formatMoney } from "@/lib/utils";
import {
  STATUS_LABELS,
  type ProductStatusValue,
} from "@/lib/validators/catalog";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Products" };

const STATUS_BADGE: Record<
  ProductStatusValue,
  "default" | "secondary" | "outline"
> = {
  DRAFT: "secondary",
  ACTIVE: "default",
  ARCHIVED: "outline",
};

/** Compact price summary for a product's variants (single price or a range). */
function priceRange(
  variants: { priceCents: number }[],
  currency: string,
): string {
  if (variants.length === 0) return "—";
  const prices = variants.map((v) => v.priceCents);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max
    ? formatMoney(min, currency)
    : `${formatMoney(min, currency)} – ${formatMoney(max, currency)}`;
}

export default async function ProductsPage() {
  const { tenantId, currency } = await requireAdminContext();
  const products = await catalogService.getAdminProducts(tenantId);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Products</h1>
          <p className="text-muted-foreground text-sm">
            Manage your catalog and variants.
          </p>
        </div>
        <Link href="/admin/products/new" className={buttonVariants()}>
          <Plus />
          New product
        </Link>
      </div>

      {products.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Package className="text-muted-foreground size-8" />
            <div className="flex flex-col gap-1">
              <p className="font-medium">No products yet</p>
              <p className="text-muted-foreground text-sm">
                Create your first product to see it here.
              </p>
            </div>
            <Link
              href="/admin/products/new"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <Plus />
              New product
            </Link>
          </CardContent>
        </Card>
      ) : (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Variants</TableHead>
                <TableHead>Price</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((product) => (
                <TableRow key={product.id}>
                  <TableCell className="font-medium">
                    <div className="flex flex-col">
                      <span>{product.title}</span>
                      <span className="text-muted-foreground text-xs">
                        /{product.slug}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_BADGE[product.status]}>
                      {STATUS_LABELS[product.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {product.variants.length}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {priceRange(product.variants, currency)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link
                      href={`/admin/products/${product.id}`}
                      className={buttonVariants({
                        variant: "outline",
                        size: "sm",
                      })}
                    >
                      Edit
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
