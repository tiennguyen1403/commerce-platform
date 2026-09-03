import type { Metadata } from "next";
import Link from "next/link";
import { SignUpForm } from "@/components/auth/sign-up-form";
import { safeInternalPath } from "@/lib/safe-redirect";
import { getStoreTenant } from "@/server/store-context";

export const metadata: Metadata = { title: "Create an account" };

// Per-request tenant read → never prerender. See the sign-in page note.
export const dynamic = "force-dynamic";

/**
 * Storefront-native sign-up — mirrors {@link ShopperSignInPage}. Client-driven
 * account creation (`authClient`, via the shared `SignUpForm`) so it never
 * clobbers an existing session; defaults a new shopper to their account home and
 * forwards a safe `?redirect=` target across the sign-in cross-link.
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
    <div className="mx-auto flex w-full max-w-sm flex-col gap-6 px-6 py-16">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Create your account
        </h1>
        <p className="text-muted-foreground text-sm">
          Sign up to check out faster and keep track of your {tenantName}{" "}
          orders.
        </p>
      </div>
      <SignUpForm redirectTo={redirectTo} />
      <p className="text-muted-foreground text-center text-sm">
        Already have an account?{" "}
        <Link
          href={signInHref}
          className="text-foreground font-medium underline underline-offset-4"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
