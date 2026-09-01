import type { Metadata } from "next";
import Link from "next/link";
import {
  Banknote,
  type LucideIcon,
  Package,
  Receipt,
  TriangleAlert,
} from "lucide-react";
import { requireAdminContext } from "@/server/auth/admin-context";
import { analyticsService } from "@/server/services/analytics.service";
import { formatDate, formatMoney } from "@/lib/utils";
import {
  ORDER_STATUS_BADGE,
  ORDER_STATUS_LABELS,
} from "@/lib/validators/orders";
import { LOW_STOCK_THRESHOLD } from "@/config/constants";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Dashboard" };

export default async function AdminHome() {
  // Reuses the layout's cached admin context — no second DB round-trip.
  const { tenantId, tenantName, currency } = await requireAdminContext();
  const dashboard = await analyticsService.getDashboard(tenantId);

  // The single "money's in, not yet shipped" figure the operator acts on next.
  const awaitingFulfillment =
    dashboard.ordersByStatus.find((s) => s.status === "PAID")?.count ?? 0;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground text-sm">
          An overview of {tenantName}.
        </p>
      </div>

      {/* KPI cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Revenue · paid + fulfilled"
          value={formatMoney(dashboard.revenueCents, currency)}
          icon={Banknote}
        />
        <StatCard
          label="Total orders"
          value={dashboard.totalOrders}
          icon={Receipt}
        />
        <StatCard
          label="Awaiting fulfillment"
          value={awaitingFulfillment}
          icon={Package}
        />
        <StatCard
          label="Low-stock variants"
          value={dashboard.lowStockCount}
          icon={TriangleAlert}
        />
      </div>

      {/* Orders by status */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight">
          Orders by status
        </h2>
        <Card>
          <CardContent>
            <dl className="flex flex-wrap gap-x-8 gap-y-4">
              {dashboard.ordersByStatus.map(({ status, count }) => (
                <div key={status} className="flex items-center gap-2">
                  <dt>
                    <Badge variant={ORDER_STATUS_BADGE[status]}>
                      {ORDER_STATUS_LABELS[status]}
                    </Badge>
                  </dt>
                  <dd className="text-sm font-medium tabular-nums">{count}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      </section>

      {/* Low stock */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">Low stock</h2>
          <p className="text-muted-foreground text-sm">
            Active variants at or below {LOW_STOCK_THRESHOLD} sellable units.
          </p>
        </div>
        {dashboard.lowStock.length === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground py-8 text-center text-sm">
              No low-stock variants.
            </CardContent>
          </Card>
        ) : (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Variant</TableHead>
                  <TableHead className="text-right">Available</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dashboard.lowStock.map((variant) => (
                  <TableRow key={variant.id}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/admin/products/${variant.productId}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {variant.productTitle}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span>{variant.name}</span>
                        <span className="text-muted-foreground text-xs">
                          {variant.sku}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {variant.available === 0 ? (
                        <Badge variant="destructive">Sold out</Badge>
                      ) : (
                        <span className="font-medium tabular-nums">
                          {variant.available}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
        {dashboard.lowStockCount > dashboard.lowStock.length ? (
          <p className="text-muted-foreground text-xs">
            Showing the {dashboard.lowStock.length} most urgent of{" "}
            {dashboard.lowStockCount}.{" "}
            <Link
              href="/admin/products"
              className="underline underline-offset-4"
            >
              Manage all
            </Link>
            .
          </p>
        ) : null}
      </section>

      {/* Recent orders */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold tracking-tight">
            Recent orders
          </h2>
          <Link
            href="/admin/orders"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            View all orders
          </Link>
        </div>
        {dashboard.recentOrders.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
              <Receipt className="text-muted-foreground size-8" aria-hidden />
              <p className="text-muted-foreground text-sm">
                Orders appear here after a customer completes checkout.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dashboard.recentOrders.map((order) => (
                  <TableRow key={order.id}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/admin/orders/${order.id}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {order.orderNumber}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(order.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={ORDER_STATUS_BADGE[order.status]}>
                        {ORDER_STATUS_LABELS[order.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(order.totalCents, order.currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </section>
    </div>
  );
}

/** A single KPI: a muted label, a large value, and a decorative corner icon.
 *  Mirrors the shadcn stat-card layout (description + title + action in the card
 *  header grid). */
function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  icon: LucideIcon;
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl font-semibold tabular-nums">
          {value}
        </CardTitle>
        <CardAction>
          <Icon className="text-muted-foreground size-4" aria-hidden />
        </CardAction>
      </CardHeader>
    </Card>
  );
}
