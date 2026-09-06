import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft, ChevronRight, Receipt } from "lucide-react";
import { getShopperSession } from "@/server/auth/shopper-context";
import { getStoreTenant } from "@/server/store-context";
import { orderService } from "@/server/services/order.service";
import { cn, formatDate, formatMoney } from "@/lib/utils";
import {
  ORDER_STATUS_BADGE,
  ORDER_STATUS_LABELS,
  accountOrdersParamsSchema,
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

export const metadata: Metadata = { title: "My orders" };

// Reads the session (headers) → dynamic; keep it explicit so the DB-less build
// never attempts to prerender this per-request page (mirrors /account).
export const dynamic = "force-dynamic";

// How many orders per page. A server constant, not user input — only `page` is
// controlled by the URL (see `accountOrdersParamsSchema`).
const PAGE_SIZE = 20;

export default async function AccountOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // Authoritative gate (unlike the nav's optimistic read): a guest is bounced to
  // the storefront sign-in with a `?redirect` back here, so they return once
  // authenticated. The session's `userId` is what scopes the query below.
  const session = await getShopperSession();
  if (!session) redirect("/account/sign-in?redirect=/account/orders");

  const { tenantId } = await getStoreTenant();
  // Forgiving parse: a mistyped ?page renders page 1, never errors.
  const { page } = accountOrdersParamsSchema.parse(await searchParams);

  // Scoped by BOTH tenant and the session-proven userId — a shopper sees only
  // their own orders for this store (never a guest's, never another shopper's).
  const { orders, total } = await orderService.listOrdersForUser(
    tenantId,
    session.user.id,
    { page, pageSize: PAGE_SIZE },
  );
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Page 1 stays implicit for a clean, shareable URL.
  const ordersHref = (target: number) =>
    target > 1 ? `/account/orders?page=${target}` : "/account/orders";

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">My orders</h1>
        {total > 0 ? (
          <p className="text-muted-foreground text-sm tabular-nums">
            {total} {total === 1 ? "order" : "orders"}
          </p>
        ) : null}
      </div>

      {total === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
            <span
              aria-hidden
              className="bg-muted text-muted-foreground flex size-14 items-center justify-center rounded-full"
            >
              <Receipt className="size-7" />
            </span>
            <div className="flex flex-col gap-1">
              <p className="text-base font-medium">No orders yet</p>
              <p className="text-muted-foreground text-sm">
                Your orders will appear here once you complete checkout.
              </p>
            </div>
            <Link
              href="/products"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Continue shopping
            </Link>
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
              href="/account/orders"
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
                <TableRow className="bg-muted/50">
                  <TableHead>Order</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">View order</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map((order) => (
                  <TableRow key={order.id}>
                    <TableCell className="font-medium">
                      <div className="flex flex-col">
                        <span className="tabular-nums">
                          {order.orderNumber}
                        </span>
                        <span className="text-muted-foreground text-xs">
                          {formatDate(order.createdAt)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={ORDER_STATUS_BADGE[order.status]}>
                        {ORDER_STATUS_LABELS[order.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(order.totalCents, order.currency)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link
                        href={`/account/orders/${order.id}`}
                        aria-label={`View order ${order.orderNumber}`}
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
                <PageLink href={ordersHref(page - 1)} disabled={page <= 1}>
                  <ChevronLeft aria-hidden />
                  Previous
                </PageLink>
                <PageLink
                  href={ordersHref(page + 1)}
                  disabled={page >= totalPages}
                >
                  Next
                  <ChevronRight aria-hidden />
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
