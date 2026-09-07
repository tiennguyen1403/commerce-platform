import type { Metadata } from "next";
import Link from "next/link";
import { UserPlus } from "lucide-react";
import { SignUpForm } from "@/components/auth/sign-up-form";
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

export const metadata: Metadata = { title: "Create an account" };

// Per-request tenant read → never prerender. See the sign-in page note.
export const dynamic = "force-dynamic";

/**
 * Storefront-native sign-up — mirrors {@link ShopperSignInPage}, including the
 * v2 layout (the {@link AuthStage} beside the card from `lg`) and the disabled,
 * planned social row (GOAL.md → Exceptions). Client-driven account creation
 * (`authClient`, via the shared `SignUpForm`) so it never clobbers an existing
 * session; defaults a new shopper to their account home and forwards a safe
 * `?redirect=` target across the sign-in cross-link.
 */
export default async function ShopperSignUpPage({
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
  const signInHref = target
    ? `/account/sign-in?redirect=${encodeURIComponent(target)}`
    : "/account/sign-in";

  return (
    <div className="mx-auto w-full max-w-6xl lg:px-6 lg:py-16">
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_400px] lg:items-center lg:gap-16">
        <AuthStage ariaLabel="Why create an account" />
        <div className="mx-auto w-full max-w-md px-4 pb-10 lg:max-w-none lg:p-0">
          <Card>
            <CardHeader>
              <div className="flex items-start gap-3">
                <span className="bg-accent text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
                  <UserPlus className="size-5" aria-hidden />
                </span>
                <div className="flex flex-col gap-1">
                  <h1 className="text-xl font-semibold tracking-tight">
                    Create your account
                  </h1>
                  <p className="text-muted-foreground text-sm text-pretty">
                    Sign up to check out faster and keep track of your{" "}
                    {tenantName} orders.
                  </p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <SignUpForm redirectTo={redirectTo} />
              <PlannedSocialSignIn dividerText="or sign up with" />
            </CardContent>
            <CardFooter className="justify-center">
              <p className="text-muted-foreground text-sm">
                Already have an account?{" "}
                <Link
                  href={signInHref}
                  className="text-foreground font-medium underline underline-offset-4"
                >
                  Sign in
                </Link>
              </p>
            </CardFooter>
          </Card>
        </div>
      </div>
    </div>
  );
}
