import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Package } from "lucide-react";
import { getShopperSession } from "@/server/auth/shopper-context";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata: Metadata = { title: "My account" };

// Reads the session (headers) → dynamic; keep it explicit so the DB-less build
// never attempts to prerender this per-request page.
export const dynamic = "force-dynamic";

/**
 * The shopper's account home and the default landing after sign-in.
 *
 * This is the authoritative gate (unlike the nav's optimistic read): a guest is
 * bounced to the storefront sign-in with a `?redirect=` back here, so they return
 * once authenticated. Order history is a follow-up — this page is the seam it
 * slots into.
 */
export default async function AccountPage() {
  const session = await getShopperSession();
  if (!session) redirect("/account/sign-in?redirect=/account");

  const { name, email } = session.user;

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-12">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">My account</h1>
        <p className="text-muted-foreground text-sm">
          Signed in as {name ? `${name} (${email})` : email}.
        </p>
      </div>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="text-muted-foreground size-5" aria-hidden />
            Orders
          </CardTitle>
          <CardDescription>
            Your order history will appear here once you place an order.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button nativeButton={false} render={<Link href="/products" />}>
            Continue shopping
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
