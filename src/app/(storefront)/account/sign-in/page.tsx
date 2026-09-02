import type { Metadata } from "next";
import Link from "next/link";
import { SignInForm } from "@/components/auth/sign-in-form";
import { safeInternalPath } from "@/lib/safe-redirect";
import { getStoreTenant } from "@/server/store-context";

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
    <div className="mx-auto flex w-full max-w-sm flex-col gap-6 px-6 py-16">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
        <p className="text-muted-foreground text-sm">
          Sign in to {tenantName} to check out faster and track your orders.
        </p>
      </div>
      <SignInForm redirectTo={redirectTo} />
      <p className="text-muted-foreground text-center text-sm">
        New to {tenantName}?{" "}
        <Link
          href={signUpHref}
          className="text-foreground font-medium underline underline-offset-4"
        >
          Create an account
        </Link>
      </p>
    </div>
  );
}
