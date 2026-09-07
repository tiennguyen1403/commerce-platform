import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CircleAlert,
  CircleCheck,
  Clock,
  MapPin,
  Package,
  SearchX,
  type LucideIcon,
} from "lucide-react";
import { getStoreTenant } from "@/server/store-context";
import { orderService } from "@/server/services/order.service";
import { cn, formatMoney } from "@/lib/utils";
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
  const showRecap = order && (view === "succeeded" || view === "processing");

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

  // The status circle keys off the verified view: emerald for the paid moment,
  // neutral for the "waiting"/"stale link" states, destructive only for a real
  // payment failure — so failed/invalid read as clearly not the succeeded moment.
  const status: { icon: LucideIcon; tint: string } = {
    succeeded: { icon: CircleCheck, tint: "bg-primary/10 text-primary" },
    processing: { icon: Clock, tint: "bg-muted text-muted-foreground" },
    failed: { icon: CircleAlert, tint: "bg-destructive/10 text-destructive" },
    invalid: { icon: SearchX, tint: "bg-muted text-muted-foreground" },
  }[view];
  const StatusIcon = status.icon;

  // Shipping address is already on the order row (#135) — no extra query. Build
  // the printable lines defensively so a missing field never renders a stray comma.
  const addressLines = order
    ? [
        order.shipLine1,
        order.shipLine2,
        [
          order.shipCity,
          [order.shipState, order.shipPostalCode].filter(Boolean).join(" "),
        ]
          .filter(Boolean)
          .join(", "),
        order.shipCountry,
      ].filter((line): line is string => Boolean(line && line.trim()))
    : [];

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-8 px-6 py-16">
      {/* Empties the cart once, and only on a verified succeeded payment. */}
      <CheckoutComplete succeeded={view === "succeeded"} />

      {/* Hero — the deliberate moment, shared by every state via the status circle. */}
      <div className="flex flex-col items-center gap-4 text-center">
        <span
          className={cn(
            "flex size-14 items-center justify-center rounded-full",
            status.tint,
          )}
        >
          <StatusIcon className="size-7" aria-hidden />
        </span>

        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight text-balance">
            {heading}
          </h1>
          <p className="text-muted-foreground text-sm text-pretty">{message}</p>
        </div>

        {showRecap ? (
          <span className="bg-muted inline-flex items-center rounded-full px-3 py-1 text-sm font-medium tabular-nums">
            Order #{order.orderNumber}
          </span>
        ) : null}
      </div>

      {/* Recap — the checkout's SectionPanel idiom, so the flow stays visually one piece. */}
      {showRecap ? (
        <div className="flex flex-col gap-4">
          <SectionPanel
            icon={Package}
            title="Order summary"
            description="What you ordered."
          >
            <ul className="flex flex-col gap-3 text-sm">
              {order.items.map((item) => (
                <li
                  key={item.id}
                  className="flex items-start justify-between gap-4"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{item.titleSnapshot}</p>
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
            <div className="flex items-center justify-between border-t pt-3 text-base">
              <span className="font-medium">Total</span>
              <span className="font-semibold tabular-nums">
                {formatMoney(order.totalCents, order.currency)}
              </span>
            </div>
          </SectionPanel>

          <SectionPanel
            icon={MapPin}
            title="Shipping to"
            description="Where it's headed."
          >
            <div className="flex flex-col gap-3 text-sm">
              {order.shipName || addressLines.length > 0 ? (
                <div className="flex flex-col gap-0.5">
                  {order.shipName ? (
                    <p className="font-medium">{order.shipName}</p>
                  ) : null}
                  {addressLines.map((line, i) => (
                    <p key={`${i}-${line}`} className="text-muted-foreground">
                      {line}
                    </p>
                  ))}
                </div>
              ) : null}
              <div className="flex items-center justify-between gap-4 border-t pt-3">
                <span className="text-muted-foreground">Confirmation</span>
                <span className="max-w-[14rem] truncate font-medium">
                  {order.email}
                </span>
              </div>
            </div>
          </SectionPanel>
        </div>
      ) : null}

      {/* Failed gets a distinct destructive note with the recovery path. */}
      {view === "failed" ? (
        <div className="border-destructive/25 bg-destructive/5 flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm">
          <CircleAlert
            className="text-destructive mt-0.5 size-4 shrink-0"
            aria-hidden
          />
          <p>You can try again with the same card or a different one.</p>
        </div>
      ) : null}

      {view === "failed" ? (
        <div className="flex flex-col gap-2">
          <Button
            size="lg"
            nativeButton={false}
            render={<Link href="/checkout" />}
            className="w-full"
          >
            Back to checkout
          </Button>
          <Button
            variant="outline"
            size="lg"
            nativeButton={false}
            render={<Link href="/products" />}
            className="w-full"
          >
            Continue shopping
          </Button>
        </div>
      ) : (
        <Button
          size="lg"
          nativeButton={false}
          render={<Link href="/products" />}
          className="w-full"
        >
          Continue shopping
          <ArrowRight aria-hidden />
        </Button>
      )}
    </div>
  );
}

/** A titled recap section — an accent icon chip, a heading + one-line description,
 *  then the section's content. Mirrors the checkout form's `SectionPanel` so the
 *  checkout → confirmation flow reads as one designed piece; kept local (server-safe)
 *  since the checkout one lives in a client component. `role="group"` + the heading
 *  name the group for assistive tech. */
function SectionPanel({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const headingId = `confirm-${title.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <Card>
      <CardContent
        role="group"
        aria-labelledby={headingId}
        className="flex flex-col gap-4"
      >
        <div className="flex items-start gap-3">
          <span className="bg-accent text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
            <Icon className="size-5" aria-hidden />
          </span>
          <div className="flex flex-col gap-0.5">
            <h2
              id={headingId}
              className="text-base font-semibold tracking-tight"
            >
              {title}
            </h2>
            <p className="text-muted-foreground text-sm">{description}</p>
          </div>
        </div>
        {children}
      </CardContent>
    </Card>
  );
}
