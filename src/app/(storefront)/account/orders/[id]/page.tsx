import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, Truck } from "lucide-react";
import { getShopperSession } from "@/server/auth/shopper-context";
import { getStoreTenant } from "@/server/store-context";
import { orderService } from "@/server/services/order.service";
import { cn, formatDate, formatMoney } from "@/lib/utils";
import {
  ORDER_STATUS_BADGE,
  ORDER_STATUS_LABELS,
  formatShippingAddressLines,
  shopperShipmentView,
  trackingHref,
} from "@/lib/validators/orders";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Order" };

// Reads the session (headers) → dynamic; keep it explicit so the DB-less build
// never attempts to prerender this per-request page (mirrors /account).
export const dynamic = "force-dynamic";

export default async function AccountOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Authoritative gate: a guest is bounced to sign-in and returns to this order
  // once authenticated. The session's `userId` scopes the read below.
  const session = await getShopperSession();
  if (!session) {
    // Encode the id in the querystring value (it's a path segment we control, so
    // safe in practice, but this stays robust to any id shape and matches the
    // sign-in page's own encodeURIComponent forwarding).
    redirect(
      `/account/sign-in?redirect=/account/orders/${encodeURIComponent(id)}`,
    );
  }

  const { tenantId } = await getStoreTenant();

  // Scoped by BOTH tenant AND the session-proven userId (never the tenant-only
  // `getOrder`): another shopper's order id, a guest order, or an order on a
  // different store all resolve to null. Awaited directly (not wrapped in
  // Suspense) and this segment has no `loading.tsx`, so `notFound()` yields a
  // real 404 — a streamed boundary would turn it into a soft-404 (a 200 with the
  // not-found UI).
  const order = await orderService.getOrderForUser(
    tenantId,
    session.user.id,
    id,
  );
  if (!order) notFound();

  const status = order.status;

  // Shopper-friendly shipment view (M4 #142): a plain-language status, the
  // tracking link, and the shipping address — never our internal fulfillment
  // states or provider ids. All read off the order the service already returned.
  const shipment = shopperShipmentView(status, order.fulfillmentStatus);
  const addressLines = formatShippingAddressLines(order);
  const trackingUrl = trackingHref(order.trackingUrl);
  const hasTracking = Boolean(order.trackingCarrier || order.trackingNumber);
  // Show the shipping card only when there's a shipment to speak of (on its way /
  // shipped) or a tracking record — a pending/cancelled/refunded order's story is
  // already told by the status badge above.
  const showShipping = shipment !== null || hasTracking;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10">
      <div className="flex flex-col gap-2">
        <Link
          href="/account/orders"
          className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-sm font-medium"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Back to orders
        </Link>
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
      </div>

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

      {showShipping ? (
        <Card>
          <CardHeader>
            <CardTitle>Shipping</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5 text-sm">
            {shipment ? (
              <div className="flex flex-col gap-1">
                <p className="font-medium">{shipment.label}</p>
                <p className="text-muted-foreground">{shipment.description}</p>
              </div>
            ) : null}

            {hasTracking ? (
              <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                {order.trackingCarrier ? (
                  <div className="flex flex-col gap-1">
                    <dt className="text-muted-foreground">Carrier</dt>
                    <dd>{order.trackingCarrier}</dd>
                  </div>
                ) : null}
                {order.trackingNumber ? (
                  <div className="flex flex-col gap-1">
                    <dt className="text-muted-foreground">Tracking number</dt>
                    <dd className="break-all">{order.trackingNumber}</dd>
                  </div>
                ) : null}
              </dl>
            ) : null}

            {trackingUrl ? (
              <a
                href={trackingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(buttonVariants({ size: "sm" }), "w-fit")}
              >
                <Truck aria-hidden />
                Track shipment
              </a>
            ) : null}

            {addressLines.length > 0 ? (
              <div className="flex flex-col gap-1">
                <p className="text-muted-foreground">Shipping to</p>
                <address className="text-foreground leading-relaxed not-italic">
                  {addressLines.map((line, i) => (
                    <span key={i} className="block">
                      {line}
                    </span>
                  ))}
                </address>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <dt className="text-muted-foreground">Placed</dt>
              <dd>{formatDate(order.createdAt, true)}</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-muted-foreground">Confirmation sent to</dt>
              <dd className="break-words">{order.email}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
