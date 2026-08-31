import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Info, ShoppingCart } from "lucide-react";
import { getStoreTenant } from "@/server/store-context";
import { readCart } from "@/server/cart-cookie";
import { cartService } from "@/server/services/cart.service";
import { formatMoney } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckoutForm } from "./checkout-form";

export const metadata: Metadata = {
  title: "Checkout",
  description: "Enter your details and pay securely.",
};

// Reads the tenant (a Prisma query) and the cart cookie, so it must never be
// prerendered — otherwise a DB-less CI build fails resolving the tenant. Mirrors
// the cart/product routes' `force-dynamic`.
export const dynamic = "force-dynamic";

export default async function CheckoutPage() {
  const { tenantId, currency } = await getStoreTenant();
  const cart = await cartService.getCartView(
    tenantId,
    await readCart(),
    currency,
  );

  const itemLabel = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;

  if (cart.items.length === 0) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10">
        <header className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold tracking-tight">Checkout</h1>
        </header>
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
            <ShoppingCart className="text-muted-foreground size-8" />
            <div className="flex flex-col gap-1">
              <p className="font-medium">Your cart is empty</p>
              <p className="text-muted-foreground text-sm">
                Add something to your cart before checking out.
              </p>
            </div>
            <Button nativeButton={false} render={<Link href="/products" />}>
              Browse products
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">Checkout</h1>
        <p className="text-muted-foreground">
          Enter your details and pay securely to place your order.
        </p>
      </header>

      <div className="grid gap-8 lg:grid-cols-[1fr_20rem] lg:items-start">
        <div className="flex flex-col gap-4">
          {cart.removedCount > 0 || cart.adjusted ? (
            <div
              role="status"
              className="border-border bg-muted/40 flex items-start gap-2 rounded-lg border px-4 py-3 text-sm"
            >
              <Info className="text-muted-foreground mt-0.5 size-4 shrink-0" />
              <span>
                Your cart changed since you last saw it — the total below
                reflects what&apos;s currently available.
              </span>
            </div>
          ) : null}

          <Card>
            <CardContent className="py-6">
              <CheckoutForm />
            </CardContent>
          </Card>

          <Button
            variant="ghost"
            size="sm"
            nativeButton={false}
            render={<Link href="/cart" />}
            className="w-fit"
          >
            <ArrowLeft />
            Back to cart
          </Button>
        </div>

        <Card className="lg:sticky lg:top-6">
          <CardHeader>
            <CardTitle>Order summary</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm">
            <ul className="flex flex-col gap-3">
              {cart.items.map((item) => (
                <li
                  key={item.variantId}
                  className="flex items-start justify-between gap-3"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">
                      {item.productTitle}
                    </span>
                    <span className="text-muted-foreground">
                      {item.variantName} · {itemLabel(item.qty)}
                    </span>
                  </div>
                  <span className="shrink-0 font-medium tabular-nums">
                    {formatMoney(item.lineTotalCents, item.currency)}
                  </span>
                </li>
              ))}
            </ul>

            <div className="flex items-center justify-between border-t pt-3 text-base">
              <span className="font-medium">Total</span>
              <span className="font-semibold tabular-nums">
                {formatMoney(cart.totalCents, cart.currency)}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
