import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink, TriangleAlert } from "lucide-react";
import { requireAdminContext } from "@/server/auth/admin-context";
import { orderService } from "@/server/services/order.service";
import { ROLES, hasAtLeast } from "@/config/roles";
import { formatDate, formatMoney } from "@/lib/utils";
import {
  FULFILLMENT_STATUS_BADGE,
  FULFILLMENT_STATUS_LABELS,
  ORDER_STATUS_BADGE,
  ORDER_STATUS_LABELS,
  formatShippingAddressLines,
  fulfillmentAttention,
  trackingHref,
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

  // Fulfillment view (M4 #142): the internal state, any provider/tracking detail,
  // the shipping address, and a "needs attention" callout for a failed / stuck
  // order. All read off the order the service already returned — no extra query.
  const fulfillmentStatus = order.fulfillmentStatus;
  const attention = fulfillmentAttention(
    fulfillmentStatus,
    order.fulfillmentStuckAt,
  );
  const addressLines = formatShippingAddressLines(order);
  const trackingUrl = trackingHref(order.trackingUrl);

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
          <CardTitle>Fulfillment</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {attention ? (
            <div className="border-destructive/30 bg-destructive/10 flex gap-3 rounded-lg border p-4 text-sm">
              <TriangleAlert
                className="text-destructive mt-0.5 size-5 shrink-0"
                aria-hidden
              />
              <div className="flex flex-col gap-1">
                <p className="text-foreground font-medium">{attention.title}</p>
                <p className="text-muted-foreground">{attention.description}</p>
              </div>
            </div>
          ) : null}

          <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <dt className="text-muted-foreground">Fulfillment status</dt>
              <dd>
                <Badge variant={FULFILLMENT_STATUS_BADGE[fulfillmentStatus]}>
                  {FULFILLMENT_STATUS_LABELS[fulfillmentStatus]}
                </Badge>
              </dd>
            </div>
            {order.fulfillmentProvider ? (
              <div className="flex flex-col gap-1">
                <dt className="text-muted-foreground">Provider</dt>
                <dd className="capitalize">{order.fulfillmentProvider}</dd>
              </div>
            ) : null}
            {order.fulfillmentProviderStatus ? (
              <div className="flex flex-col gap-1">
                <dt className="text-muted-foreground">Provider status</dt>
                <dd className="font-mono text-xs break-all">
                  {order.fulfillmentProviderStatus}
                </dd>
              </div>
            ) : null}
            {order.fulfillmentExternalId ? (
              <div className="flex flex-col gap-1">
                <dt className="text-muted-foreground">Provider order ID</dt>
                <dd className="text-muted-foreground font-mono text-xs break-all">
                  {order.fulfillmentExternalId}
                </dd>
              </div>
            ) : null}
            {order.trackingCarrier ? (
              <div className="flex flex-col gap-1">
                <dt className="text-muted-foreground">Carrier</dt>
                <dd>{order.trackingCarrier}</dd>
              </div>
            ) : null}
            {order.trackingNumber ? (
              <div className="flex flex-col gap-1">
                <dt className="text-muted-foreground">Tracking number</dt>
                <dd className="break-all">
                  {trackingUrl ? (
                    <a
                      href={trackingUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary inline-flex items-center gap-1 font-medium hover:underline"
                    >
                      {order.trackingNumber}
                      <ExternalLink className="size-3.5" aria-hidden />
                    </a>
                  ) : (
                    order.trackingNumber
                  )}
                </dd>
              </div>
            ) : null}
            {order.fulfillmentStuckAt ? (
              <div className="flex flex-col gap-1">
                <dt className="text-muted-foreground">Flagged stuck</dt>
                <dd>{formatDate(order.fulfillmentStuckAt, true)}</dd>
              </div>
            ) : null}
          </dl>

          <div className="flex flex-col gap-1 text-sm">
            <p className="text-muted-foreground">Shipping address</p>
            {addressLines.length > 0 ? (
              <address className="text-foreground leading-relaxed not-italic">
                {addressLines.map((line, i) => (
                  <span key={i} className="block">
                    {line}
                  </span>
                ))}
              </address>
            ) : (
              <p className="text-muted-foreground">
                No shipping address on this order.
              </p>
            )}
          </div>
        </CardContent>
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
