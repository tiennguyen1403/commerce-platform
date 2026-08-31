import Link from "next/link";
import { Activity, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

const STACK = [
  "Next.js 16",
  "React 19",
  "TypeScript",
  "Tailwind v4",
  "Prisma",
  "PostgreSQL",
  "Better Auth",
  "Stripe",
];

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col justify-center gap-10 px-6 py-24">
      <div className="flex flex-col gap-4">
        <span className="border-border text-muted-foreground inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium">
          <span className="bg-primary size-1.5 rounded-full" aria-hidden />
          Phase 0 · foundations live
        </span>
        <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          Multi-tenant commerce platform
        </h1>
        <p className="text-muted-foreground max-w-xl text-lg leading-7">
          A production-grade storefront, admin, and fulfillment engine — built
          end-to-end. Each store is an isolated tenant, so the same codebase can
          power one shop or many.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {STACK.map((item) => (
          <span
            key={item}
            className="bg-muted text-muted-foreground rounded-md px-2.5 py-1 text-sm"
          >
            {item}
          </span>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="lg"
          nativeButton={false}
          render={<Link href="/products" />}
        >
          Shop the store
          <ArrowRight />
        </Button>
        <Button
          size="lg"
          variant="outline"
          nativeButton={false}
          render={<Link href="/admin" />}
        >
          Admin
        </Button>
        <Button
          size="lg"
          variant="ghost"
          nativeButton={false}
          render={<a href="/api/health" />}
        >
          <Activity />
          Health check
        </Button>
      </div>
    </main>
  );
}
