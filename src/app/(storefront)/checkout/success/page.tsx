import type { Metadata } from "next";
import Link from "next/link";
import { CircleAlert, CircleCheck, Clock } from "lucide-react";
import { getStoreTenant } from "@/server/store-context";
import { orderService } from "@/server/services/order.service";
import { formatMoney } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CheckoutComplete } from "./checkout-complete";

export const metadata: Metadata = {
  title: "Order confirmation",
  description: "Your checkout result.",
};

// Reads `searchParams` and looks the order up by PaymentIntent id (a Prisma
// query), so it renders per-request and must not be prerendered.
export const dynamic = "force-dynamic";

/**
 * Stripe redirects here after `confirmPayment`, appending `payment_intent` and
 * `redirect_status`. We look the order up by its PaymentIntent id (tenant-scoped)
 * to show a real confirmation. The order is still PENDING at this point — the
 * webhook (#14) confirms payment server-side and flips it to PAID — so the copy
 * keys off Stripe's `redirect_status`, not the DB status.
 */
export default async function CheckoutSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{
    payment_intent?: string | string[];
    redirect_status?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const paymentIntentId =
    typeof params.payment_intent === "string"
      ? params.payment_intent
      : undefined;
  const redirectStatus =
    typeof params.redirect_status === "string"
      ? params.redirect_status
      : undefined;

  const { tenantId } = await getStoreTenant();
  const order = paymentIntentId
    ? await orderService.getOrderByPaymentIntent(tenantId, paymentIntentId)
    : null;

  const succeeded = redirectStatus === "succeeded";
  const processing = redirectStatus === "processing";

  const heading = succeeded
    ? "Payment received"
    : processing
      ? "Payment processing"
      : "Payment not completed";

  const message = succeeded
    ? "Thanks for your order — we're getting it ready."
    : processing
      ? "Your payment is still processing. We'll email you once it's confirmed."
      : "We couldn't confirm your payment. Your card was not charged.";

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-6 px-6 py-16">
      {/* Empties the cart once, but only on a succeeded payment. */}
      <CheckoutComplete redirectStatus={redirectStatus} />

      <Card>
        <CardContent className="flex flex-col items-center gap-6 py-12 text-center">
          <span
            className={
              succeeded
                ? "bg-primary/10 text-primary flex size-14 items-center justify-center rounded-full"
                : processing
                  ? "bg-muted text-muted-foreground flex size-14 items-center justify-center rounded-full"
                  : "bg-destructive/10 text-destructive flex size-14 items-center justify-center rounded-full"
            }
          >
            {succeeded ? (
              <CircleCheck className="size-7" />
            ) : processing ? (
              <Clock className="size-7" />
            ) : (
              <CircleAlert className="size-7" />
            )}
          </span>

          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
            <p className="text-muted-foreground text-sm">{message}</p>
          </div>

          {order && (succeeded || processing) ? (
            <dl className="border-border w-full max-w-xs rounded-lg border text-sm">
              <div className="flex items-center justify-between gap-4 px-4 py-3">
                <dt className="text-muted-foreground">Order</dt>
                <dd className="font-medium tabular-nums">
                  {order.orderNumber}
                </dd>
              </div>
              <div className="border-border flex items-center justify-between gap-4 border-t px-4 py-3">
                <dt className="text-muted-foreground">Total</dt>
                <dd className="font-semibold tabular-nums">
                  {formatMoney(order.totalCents, order.currency)}
                </dd>
              </div>
              <div className="border-border flex items-center justify-between gap-4 border-t px-4 py-3">
                <dt className="text-muted-foreground">Confirmation</dt>
                <dd className="max-w-[12rem] truncate font-medium">
                  {order.email}
                </dd>
              </div>
            </dl>
          ) : null}

          {succeeded || processing ? (
            <Button nativeButton={false} render={<Link href="/products" />}>
              Continue shopping
            </Button>
          ) : (
            <Button nativeButton={false} render={<Link href="/checkout" />}>
              Back to checkout
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
