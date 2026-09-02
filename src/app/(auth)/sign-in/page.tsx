import type { Metadata } from "next";
import Link from "next/link";
import { SignInForm } from "./sign-in-form";
import { safeInternalPath } from "../safe-redirect";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>;
}) {
  const { redirect } = await searchParams;
  // Honor only safe internal targets (guards against open redirects); default to
  // the admin entry. Forward the same target on the sign-up cross-link so a
  // visitor who came to reach it (e.g. `/new`) keeps it across the hop.
  const target = safeInternalPath(redirect);
  const redirectTo = target ?? "/admin";
  const signUpHref = target
    ? `/sign-up?redirect=${encodeURIComponent(target)}`
    : "/sign-up";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-muted-foreground text-sm">
          Enter your credentials to access the admin.
        </p>
      </div>
      <SignInForm redirectTo={redirectTo} />
      <p className="text-muted-foreground text-center text-sm">
        Don&apos;t have an account?{" "}
        <Link
          href={signUpHref}
          className="text-foreground font-medium underline underline-offset-4"
        >
          Sign up
        </Link>
      </p>
    </div>
  );
}
