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

// Retrieves the PaymentIntent from Stripe and reads the order (a Prisma query),
// so it renders per-request and must not be prerendered.
export const dynamic = "force-dynamic";

/**
 * Stripe redirects here after `confirmPayment`, appending `payment_intent`,
 * `payment_intent_client_secret`, and `redirect_status`. The id alone is not
 * proof of ownership, so the service verifies the client secret against the live
 * intent before returning any (PII-bearing) order detail, and the intent's real
 * status — not the client-supplied `redirect_status` — drives the copy. The order
 * is still PENDING here; the webhook (#14) confirms payment and flips it to PAID.
 */
export default async function CheckoutSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{
    payment_intent?: string | string[];
    payment_intent_client_secret?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const paymentIntentId =
    typeof params.payment_intent === "string"
      ? params.payment_intent
      : undefined;
  const clientSecret =
    typeof params.payment_intent_client_secret === "string"
      ? params.payment_intent_client_secret
      : undefined;

  const { tenantId } = await getStoreTenant();
  const result =
    paymentIntentId && clientSecret
      ? await orderService.getCheckoutResult(
          tenantId,
          paymentIntentId,
          clientSecret,
        )
      : null;

  // Verified state drives everything below — an unverified link shows no order.
  const view =
    result === null
      ? "invalid"
      : result.status === "succeeded"
        ? "succeeded"
        : result.status === "processing"
          ? "processing"
          : "failed";
  const order = result?.order ?? null;

  const heading = {
    succeeded: "Payment received",
    processing: "Payment processing",
    failed: "Payment not completed",
    invalid: "Order not found",
  }[view];

  const message = {
    succeeded: "Thanks for your order — we're getting it ready.",
    processing:
      "Your payment is still processing. We'll email you once it's confirmed.",
    failed: "We couldn't confirm your payment. Your card was not charged.",
    invalid: "This confirmation link is invalid or has expired.",
  }[view];

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-6 px-6 py-16">
      {/* Empties the cart once, and only on a verified succeeded payment. */}
      <CheckoutComplete succeeded={view === "succeeded"} />

      <Card>
        <CardContent className="flex flex-col items-center gap-6 py-12 text-center">
          <span
            className={
              view === "succeeded"
                ? "bg-primary/10 text-primary flex size-14 items-center justify-center rounded-full"
                : view === "processing"
                  ? "bg-muted text-muted-foreground flex size-14 items-center justify-center rounded-full"
                  : "bg-destructive/10 text-destructive flex size-14 items-center justify-center rounded-full"
            }
          >
            {view === "succeeded" ? (
              <CircleCheck className="size-7" />
            ) : view === "processing" ? (
              <Clock className="size-7" />
            ) : (
              <CircleAlert className="size-7" />
            )}
          </span>

          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
            <p className="text-muted-foreground text-sm">{message}</p>
          </div>

          {order && (view === "succeeded" || view === "processing") ? (
            <div className="w-full max-w-sm text-left">
              <ul className="border-border rounded-lg border text-sm">
                {order.items.map((item, index) => (
                  <li
                    key={item.id}
                    className={`flex items-start justify-between gap-4 px-4 py-3 ${
                      index > 0 ? "border-border border-t" : ""
                    }`}
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {item.titleSnapshot}
                      </p>
                      <p className="text-muted-foreground text-xs tabular-nums">
                        Qty {item.quantity} &times;{" "}
                        {formatMoney(item.priceCents, order.currency)}
                      </p>
                    </div>
                    <span className="font-medium whitespace-nowrap tabular-nums">
                      {formatMoney(
                        item.priceCents * item.quantity,
                        order.currency,
                      )}
                    </span>
                  </li>
                ))}
              </ul>

              <dl className="border-border mt-3 rounded-lg border text-sm">
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
            </div>
          ) : null}

          {view === "failed" ? (
            <Button nativeButton={false} render={<Link href="/checkout" />}>
              Back to checkout
            </Button>
          ) : (
            <Button nativeButton={false} render={<Link href="/products" />}>
              Continue shopping
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
