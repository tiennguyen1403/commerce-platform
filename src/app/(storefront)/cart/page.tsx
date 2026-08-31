import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Info, ShoppingCart } from "lucide-react";
import { getStoreTenant } from "@/server/store-context";
import { readCart } from "@/server/cart-cookie";
import { cartService } from "@/server/services/cart.service";
import { formatMoney } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CartItems } from "./cart-items";
import { clearCartAction } from "./actions";

export const metadata: Metadata = {
  title: "Cart",
  description: "Review the items in your cart before checkout.",
};

// Force dynamic so Next never prerenders this route at build. It resolves the
// tenant (a Prisma read) before it ever reads the cart cookie, so the cookie's
// dynamic-bailout can't kick in first — a build with no database (CI) would hit
// the DB and fail. This matches the product listing's `force-dynamic`.
export const dynamic = "force-dynamic";

export default async function CartPage() {
  const { tenantId } = await getStoreTenant();
  const cart = await cartService.getCartView(tenantId, await readCart());

  const itemLabel = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">Your cart</h1>
        <p className="text-muted-foreground">
          Review your items before checkout.
        </p>
      </header>

      {cart.items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
            <ShoppingCart className="text-muted-foreground size-8" />
            <div className="flex flex-col gap-1">
              <p className="font-medium">Your cart is empty</p>
              <p className="text-muted-foreground text-sm">
                Add a few things from the shop and they&apos;ll show up here.
              </p>
            </div>
            <Button nativeButton={false} render={<Link href="/products" />}>
              Browse products
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-8 lg:grid-cols-[1fr_20rem] lg:items-start">
          <div className="flex flex-col gap-4">
            {cart.removedCount > 0 || cart.adjusted ? (
              <div
                role="status"
                className="border-border bg-muted/40 flex items-start gap-2 rounded-lg border px-4 py-3 text-sm"
              >
                <Info className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                <span>
                  {cart.removedCount > 0
                    ? `${itemLabel(cart.removedCount)} ${
                        cart.removedCount === 1 ? "is" : "are"
                      } no longer available and ${
                        cart.removedCount === 1 ? "was" : "were"
                      } removed. `
                    : null}
                  {cart.adjusted
                    ? "Some quantities were reduced to match available stock."
                    : null}
                </span>
              </div>
            ) : null}

            <CartItems items={cart.items} />

            <div className="flex items-center justify-between">
              <Button
                variant="ghost"
                size="sm"
                nativeButton={false}
                render={<Link href="/products" />}
              >
                <ArrowLeft />
                Continue shopping
              </Button>
              <form action={clearCartAction}>
                <Button
                  type="submit"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                >
                  Clear cart
                </Button>
              </form>
            </div>
          </div>

          <Card className="lg:sticky lg:top-6">
            <CardHeader>
              <CardTitle>Order summary</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  Subtotal · {itemLabel(cart.itemCount)}
                </span>
                <span className="font-medium tabular-nums">
                  {formatMoney(cart.totalCents, cart.currency)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Shipping</span>
                <span className="text-muted-foreground">
                  Calculated at checkout
                </span>
              </div>
              <div className="flex items-center justify-between border-t pt-3 text-base">
                <span className="font-medium">Total</span>
                <span className="font-semibold tabular-nums">
                  {formatMoney(cart.totalCents, cart.currency)}
                </span>
              </div>
            </CardContent>
            <CardFooter className="flex-col items-stretch gap-2">
              <Button
                size="lg"
                className="w-full"
                nativeButton={false}
                render={<Link href="/checkout" />}
              >
                Checkout
              </Button>
              <p className="text-muted-foreground text-center text-xs">
                You won&apos;t be charged until you confirm payment.
              </p>
            </CardFooter>
          </Card>
        </div>
      )}
    </div>
  );
}
