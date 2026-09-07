import type { Metadata } from "next";
import Link from "next/link";
import { LogIn } from "lucide-react";
import { SignInForm } from "@/components/auth/sign-in-form";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { safeInternalPath } from "@/lib/safe-redirect";
import { getStoreTenant } from "@/server/store-context";
import { AuthStage } from "../auth-stage";
import { PlannedSocialSignIn } from "../planned-social-sign-in";

export const metadata: Metadata = { title: "Sign in" };

// Reads the per-request tenant (via `getStoreTenant`), so it must never be
// prerendered — the DB-less CI build would fail. Matches the catalog/cart
// `force-dynamic` (see docs/DATABASE.md and the storefront layout note).
export const dynamic = "force-dynamic";

/**
 * Storefront-native sign-in — the shopper counterpart to the admin `(auth)`
 * surface. It renders inside the storefront shell, so it carries the store's
 * name and per-tenant accent; sign-in stays client-driven (`authClient`, via the
 * shared `SignInForm`), so it can never clobber another identity's session.
 *
 * Layout (M6-09 v2, Direction A of the "Auth Redesign v2" canvas): the
 * store-side {@link AuthStage} beside the form card from `lg`; below that a
 * full-bleed band above a centered card. Two affordances are deliberately
 * shipped ahead of their features as disabled controls that say "coming soon"
 * in their own text (GOAL.md → Exceptions): the "Forgot password?" link and
 * the social sign-in row. No auth logic was added for either.
 *
 * The default landing is the shopper's account home; a safe `?redirect=` target
 * (e.g. a gated `/account/...` page that bounced a guest here) is honored via the
 * shared open-redirect guard and forwarded on the sign-up cross-link so it
 * survives the hop.
 */
export default async function ShopperSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>;
}) {
  const [{ redirect }, { tenantName }] = await Promise.all([
    searchParams,
    getStoreTenant(),
  ]);
  const target = safeInternalPath(redirect);
  const redirectTo = target ?? "/account";
  const signUpHref = target
    ? `/account/sign-up?redirect=${encodeURIComponent(target)}`
    : "/account/sign-up";

  return (
    <div className="mx-auto w-full max-w-6xl lg:px-6 lg:py-16">
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_400px] lg:items-center lg:gap-16">
        <AuthStage ariaLabel="Why sign in" />
        <div className="mx-auto w-full max-w-md px-4 pb-10 lg:max-w-none lg:p-0">
          <Card>
            <CardHeader>
              <div className="flex items-start gap-3">
                <span className="bg-accent text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
                  <LogIn className="size-5" aria-hidden />
                </span>
                <div className="flex flex-col gap-1">
                  <h1 className="text-xl font-semibold tracking-tight">
                    Welcome back
                  </h1>
                  <p className="text-muted-foreground text-sm text-pretty">
                    Sign in to {tenantName} to check out faster and track your
                    orders.
                  </p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <SignInForm
                redirectTo={redirectTo}
                passwordAction={
                  // Planned, not implemented: disabled so it can't dead-click,
                  // and it says so in its own text — a disabled button takes no
                  // hover or focus, so a tooltip would reach nobody on keyboard,
                  // touch, or a screen reader.
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    disabled
                    className="text-foreground h-auto px-0 font-normal"
                  >
                    Forgot password? (coming soon)
                  </Button>
                }
              />
              <PlannedSocialSignIn dividerText="or continue with" />
            </CardContent>
            <CardFooter className="justify-center">
              <p className="text-muted-foreground text-sm">
                New to {tenantName}?{" "}
                <Link
                  href={signUpHref}
                  className="text-foreground font-medium underline underline-offset-4"
                >
                  Create an account
                </Link>
              </p>
            </CardFooter>
          </Card>
        </div>
      </div>
    </div>
  );
}
