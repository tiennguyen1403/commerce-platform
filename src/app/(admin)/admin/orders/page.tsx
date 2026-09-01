import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  Receipt,
  TriangleAlert,
} from "lucide-react";
import { requireAdminContext } from "@/server/auth/admin-context";
import { orderService } from "@/server/services/order.service";
import { cn, formatDate, formatMoney } from "@/lib/utils";
import {
  ORDER_STATUS_BADGE,
  ORDER_STATUS_LABELS,
  ORDER_STATUSES,
  listOrdersParamsSchema,
  type OrderStatusValue,
} from "@/lib/validators/orders";
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

export const metadata: Metadata = { title: "Orders" };

// How many orders per page. A server constant, not user input — the list query
// params (status + page) are the only thing the URL controls.
const PAGE_SIZE = 20;

/** Build a `/admin/orders` URL preserving the status filter and page (page 1 and
 *  an absent filter stay implicit, for clean shareable URLs). */
function ordersHref({
  status,
  page,
}: {
  status?: OrderStatusValue;
  page?: number;
}) {
  const sp = new URLSearchParams();
  if (status) sp.set("status", status);
  if (page && page > 1) sp.set("page", String(page));
  const qs = sp.toString();
  return qs ? `/admin/orders?${qs}` : "/admin/orders";
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { tenantId } = await requireAdminContext();
  // Forgiving parse: a mistyped ?status / ?page renders the default view, never
  // errors (see `listOrdersParamsSchema`).
  const { status, page } = listOrdersParamsSchema.parse(await searchParams);

  const { orders, total } = await orderService.listOrders(tenantId, {
    status,
    page,
    pageSize: PAGE_SIZE,
  });
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>
        <p className="text-muted-foreground text-sm">
          Review and operate customer orders.
        </p>
      </div>

      {/* Status filter — server-rendered links, no client JS. Each resets to
          page 1; the active one is highlighted. */}
      <nav
        aria-label="Filter orders by status"
        className="flex flex-wrap gap-2"
      >
        <Link
          href={ordersHref({})}
          aria-current={!status ? "page" : undefined}
          className={buttonVariants({
            variant: !status ? "default" : "outline",
            size: "sm",
          })}
        >
          All
        </Link>
        {ORDER_STATUSES.map((s) => (
          <Link
            key={s}
            href={ordersHref({ status: s })}
            aria-current={status === s ? "page" : undefined}
            className={buttonVariants({
              variant: status === s ? "default" : "outline",
              size: "sm",
            })}
          >
            {ORDER_STATUS_LABELS[s]}
          </Link>
        ))}
      </nav>

      {total === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Receipt className="text-muted-foreground size-8" />
            <div className="flex flex-col gap-1">
              <p className="font-medium">
                {status
                  ? `No ${ORDER_STATUS_LABELS[status].toLowerCase()} orders`
                  : "No orders yet"}
              </p>
              <p className="text-muted-foreground text-sm">
                {status
                  ? "Try a different status filter."
                  : "Orders appear here after a customer completes checkout."}
              </p>
            </div>
            {status ? (
              <Link
                href={ordersHref({})}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Clear filter
              </Link>
            ) : null}
          </CardContent>
        </Card>
      ) : orders.length === 0 ? (
        // A page past the end (a fiddled ?page). total > 0, so offer a way back.
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-muted-foreground text-sm">
              No orders on this page.
            </p>
            <Link
              href={ordersHref({ status })}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Back to first page
            </Link>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map((order) => (
                  <TableRow key={order.id}>
                    <TableCell className="font-medium">
                      <div className="flex flex-col">
                        <span>{order.orderNumber}</span>
                        <span className="text-muted-foreground text-xs">
                          {formatDate(order.createdAt)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Badge variant={ORDER_STATUS_BADGE[order.status]}>
                          {ORDER_STATUS_LABELS[order.status]}
                        </Badge>
                        {order.oversold ? (
                          <span title="Oversold — stock fell short at payment">
                            <TriangleAlert className="text-destructive size-3.5" />
                            <span className="sr-only">Oversold</span>
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground max-w-[16rem] truncate">
                      {order.email}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatMoney(order.totalCents, order.currency)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link
                        href={`/admin/orders/${order.id}`}
                        className={buttonVariants({
                          variant: "outline",
                          size: "sm",
                        })}
                      >
                        View
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          {totalPages > 1 ? (
            <div className="flex items-center justify-between gap-4">
              <p className="text-muted-foreground text-sm">
                Page {page} of {totalPages}
              </p>
              <div className="flex gap-2">
                <PageLink
                  href={ordersHref({ status, page: page - 1 })}
                  disabled={page <= 1}
                >
                  <ChevronLeft />
                  Previous
                </PageLink>
                <PageLink
                  href={ordersHref({ status, page: page + 1 })}
                  disabled={page >= totalPages}
                >
                  Next
                  <ChevronRight />
                </PageLink>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** A prev/next control: a real link when in range, an inert disabled-looking
 *  span at the bounds (so there's nothing to click past the ends). */
function PageLink({
  href,
  disabled,
  children,
}: {
  href: string;
  disabled: boolean;
  children: ReactNode;
}) {
  const className = buttonVariants({ variant: "outline", size: "sm" });
  if (disabled) {
    return (
      <span
        aria-disabled="true"
        className={cn(className, "pointer-events-none opacity-50")}
      >
        {children}
      </span>
    );
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
