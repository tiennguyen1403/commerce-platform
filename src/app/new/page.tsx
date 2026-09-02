import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Store } from "lucide-react";
import { auth } from "@/server/auth";
import { NewStoreForm } from "./new-store-form";

export const metadata: Metadata = { title: "Create your store" };

// Reads the session, so it can never be prerendered (there's no session/DB at
// build time). This bare top-level route has no dynamic layout above it to force
// that — declare it here, mirroring the bare `/admin` entry.
export const dynamic = "force-dynamic";

/**
 * Self-serve onboarding entry. A signed-in user creates a store and becomes its
 * OWNER (the write happens in the Server Action). Gate the page so a logged-out
 * visitor is sent to sign in and bounced right back here — the Server Action is
 * the authoritative boundary; this redirect is just the friendly front door.
 */
export default async function NewStorePage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in?redirect=/new");

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-6 py-16">
      <div className="flex flex-col gap-3">
        <span className="border-border text-muted-foreground inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium">
          <Store className="size-3.5" aria-hidden />
          New store
        </span>
        <h1 className="text-3xl font-semibold tracking-tight">
          Create your store
        </h1>
        <p className="text-muted-foreground text-sm leading-6">
          Pick a name and a subdomain to get started. You can invite teammates
          and configure the rest once it&apos;s live.
        </p>
      </div>
      <NewStoreForm />
    </main>
  );
}
