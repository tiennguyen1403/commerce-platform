import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, IdCard, Package, UserRound } from "lucide-react";
import { getShopperSession } from "@/server/auth/shopper-context";
import { Button } from "@/components/ui/button";
import { SectionPanel } from "./section-panel";

export const metadata: Metadata = { title: "My account" };

// Reads the session (headers) → dynamic; keep it explicit so the DB-less build
// never attempts to prerender this per-request page.
export const dynamic = "force-dynamic";

/**
 * The shopper's account home and the default landing after sign-in.
 *
 * This is the authoritative gate (unlike the nav's optimistic read): a guest is
 * bounced to the storefront sign-in with a `?redirect=` back here, so they return
 * once authenticated. It's a small hub — the identity, the primary route into
 * order history, and the account details already on the session — deliberately
 * built from the session alone (no order read here; that stays on /account/orders,
 * per the milestone's UI-only contract).
 */
export default async function AccountPage() {
  const session = await getShopperSession();
  if (!session) redirect("/account/sign-in?redirect=/account");

  const { name, email } = session.user;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-6 py-12">
      {/* Identity header — a neutral avatar chip (the accent is reserved for the
          section chips and the primary action below). */}
      <div className="flex items-center gap-4">
        <span
          aria-hidden
          className="bg-muted text-muted-foreground flex size-12 shrink-0 items-center justify-center rounded-full"
        >
          <UserRound className="size-6" />
        </span>
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">My account</h1>
          <p className="text-muted-foreground text-sm">
            Signed in as {name ? `${name} (${email})` : email}.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {/* Orders — the primary destination, so it carries the filled CTA. */}
        <SectionPanel
          icon={Package}
          title="Order history"
          description="Track and review the orders you've placed with this store."
        >
          <Button
            nativeButton={false}
            render={<Link href="/account/orders" />}
            className="w-fit"
          >
            View order history
            <ArrowRight aria-hidden />
          </Button>
        </SectionPanel>

        {/* Account details — read-only identity already on the session. */}
        <SectionPanel
          icon={IdCard}
          title="Account details"
          description="How we identify and reach you."
        >
          <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <dt className="text-muted-foreground">Name</dt>
              <dd className="font-medium">
                {name || (
                  <span className="text-muted-foreground font-normal">
                    Not set
                  </span>
                )}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-muted-foreground">Email</dt>
              <dd className="font-medium break-words">{email}</dd>
            </div>
          </dl>
        </SectionPanel>
      </div>

      {/* Secondary action — quiet outline, so the primary reads as primary. */}
      <Button
        variant="outline"
        nativeButton={false}
        render={<Link href="/products" />}
        className="w-full"
      >
        Continue shopping
      </Button>
    </div>
  );
}
