import type { Metadata } from "next";
import Link from "next/link";
import { SignUpForm } from "./sign-up-form";
import { safeInternalPath } from "../safe-redirect";

export const metadata: Metadata = { title: "Sign up" };

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>;
}) {
  const { redirect } = await searchParams;
  // A fresh account has no store yet, so default to the storefront; but honor a
  // safe target (e.g. `/new`) so a visitor who came to create a store lands
  // there right after signing up. Forward it on the sign-in cross-link too.
  const target = safeInternalPath(redirect);
  const redirectTo = target ?? "/";
  const signInHref = target
    ? `/sign-in?redirect=${encodeURIComponent(target)}`
    : "/sign-in";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Create an account
        </h1>
        <p className="text-muted-foreground text-sm">
          Sign up to get started. Admin access is granted separately.
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
