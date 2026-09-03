import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, TriangleAlert } from "lucide-react";
import { requireAdminContext } from "@/server/auth/admin-context";
import { orderService } from "@/server/services/order.service";
import { ROLES, hasAtLeast } from "@/config/roles";
import { formatDate, formatMoney } from "@/lib/utils";
import {
  ORDER_STATUS_BADGE,
  ORDER_STATUS_LABELS,
} from "@/lib/validators/orders";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { OrderActions } from "../order-actions";

export const metadata: Metadata = { title: "Order" };

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ storeSlug: string; id: string }>;
}) {
  const { storeSlug, id } = await params;
  const { tenantId, role } = await requireAdminContext(storeSlug);

  // Awaited directly (not wrapped in Suspense) and this segment has no
  // `loading.tsx`, so `notFound()` yields a real 404 — a streamed boundary would
  // turn it into a soft-404 (a 200 with the not-found UI).
  const order = await orderService.getOrder(tenantId, id);
  if (!order) notFound();

  // Refund is ADMIN+ (cancel/fulfil are STAFF+); the buttons re-check server-side.
  const canRefund = hasAtLeast(role, ROLES.ADMIN);
  const status = order.status;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10">
      <div className="flex flex-col gap-2">
        <Link
          href={`/admin/${storeSlug}/orders`}
          className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-sm font-medium"
        >
          <ArrowLeft className="size-4" />
          Back to orders
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">
                {order.orderNumber}
              </h1>
              <Badge variant={ORDER_STATUS_BADGE[status]}>
                {ORDER_STATUS_LABELS[status]}
              </Badge>
            </div>
            <p className="text-muted-foreground text-sm">
              Placed {formatDate(order.createdAt, true)}
            </p>
          </div>
          <OrderActions
            storeSlug={storeSlug}
            orderId={order.id}
            status={status}
            oversold={order.oversold}
            canRefund={canRefund}
          />
        </div>
      </div>

      {order.oversold ? (
        <div className="border-destructive/30 bg-destructive/10 flex gap-3 rounded-lg border p-4 text-sm">
          <TriangleAlert className="text-destructive mt-0.5 size-5 shrink-0" />
          <div className="flex flex-col gap-1">
            <p className="text-foreground font-medium">
              This order was oversold
            </p>
            <p className="text-muted-foreground">
              One or more items couldn&rsquo;t be fully allocated from stock
              when payment was captured — another order took the last units
              during the payment window. The payment is valid and the order
              stands paid; review the items and consider a refund before
              fulfilling.
            </p>
          </div>
        </div>
      ) : null}

      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Unit price</TableHead>
              <TableHead className="text-right">Line total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {order.items.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="font-medium">
                  {item.titleSnapshot}
                </TableCell>
                <TableCell className="text-muted-foreground text-right">
                  {item.quantity}
                </TableCell>
                <TableCell className="text-muted-foreground text-right">
                  {formatMoney(item.priceCents, order.currency)}
                </TableCell>
                <TableCell className="text-right">
                  {formatMoney(item.priceCents * item.quantity, order.currency)}
                </TableCell>
              </TableRow>
            ))}
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={3} className="font-semibold">
                Total
              </TableCell>
              <TableCell className="text-right font-semibold">
                {formatMoney(order.totalCents, order.currency)}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <dt className="text-muted-foreground">Customer</dt>
              <dd className="break-words">{order.email}</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-muted-foreground">Placed</dt>
              <dd>{formatDate(order.createdAt, true)}</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                <Badge variant={ORDER_STATUS_BADGE[status]}>
                  {ORDER_STATUS_LABELS[status]}
                </Badge>
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-muted-foreground">Payment reference</dt>
              <dd className="text-muted-foreground font-mono text-xs break-all">
                {order.stripePaymentIntentId ?? "—"}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
