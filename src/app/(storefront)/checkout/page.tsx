import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Info, Lock, ShoppingCart } from "lucide-react";
import { getStoreTenant } from "@/server/store-context";
import { readCart } from "@/server/cart-cookie";
import { cartService } from "@/server/services/cart.service";
import { formatMoney } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ProductImageFrame } from "../products/product-image";
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
          <p className="text-muted-foreground">
            Enter your details and pay securely to place your order.
          </p>
        </header>
        {/* The house tinted-circle empty state, shared with /cart, /products and
            /search — a neutral circle, not the success/error tints. */}
        <Card>
          <CardContent className="flex flex-col items-center gap-5 py-16 text-center">
            <span className="bg-muted text-muted-foreground flex size-14 items-center justify-center rounded-full">
              <ShoppingCart className="size-7" aria-hidden />
            </span>
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

          <CheckoutForm />

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
            <CardDescription>{itemLabel(cart.itemCount)}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm">
            <ul className="flex flex-col gap-3">
              {cart.items.map((item) => (
                <li key={item.variantId} className="flex items-center gap-3">
                  {/* Recognition thumbnail — display-only, not a link (checkout
                      shouldn't invite navigating away). The frame owns the square;
                      ProductImageFrame fills it or shows the placeholder icon. */}
                  <span className="bg-muted relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md border">
                    <ProductImageFrame
                      image={item.image}
                      productTitle={item.productTitle}
                      sizes="48px"
                      iconClassName="size-5"
                    />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">
                      {item.productTitle}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {item.variantName} · Qty {item.qty}
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
          <CardFooter>
            <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Lock className="size-3 shrink-0" aria-hidden />
              Secure, encrypted checkout.
            </p>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
