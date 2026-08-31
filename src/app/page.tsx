import Link from "next/link";

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
        <span className="inline-flex w-fit items-center gap-2 rounded-full border border-black/10 px-3 py-1 text-xs font-medium text-zinc-600 dark:border-white/15 dark:text-zinc-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Phase 0 · foundations live
        </span>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Multi-tenant commerce platform
        </h1>
        <p className="max-w-xl text-lg text-zinc-600 dark:text-zinc-400">
          A production-grade storefront, admin, and fulfillment engine — built
          end-to-end. Each store is an isolated tenant, so the same codebase can
          power one shop or many.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {STACK.map((item) => (
          <span
            key={item}
            className="rounded-md bg-black/[.05] px-2.5 py-1 text-sm text-zinc-700 dark:bg-white/[.08] dark:text-zinc-300"
          >
            {item}
          </span>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        <Link
          href="/products"
          className="bg-foreground text-background rounded-full px-4 py-2 font-medium"
        >
          Shop the store
        </Link>
        <Link
          href="/admin"
          className="rounded-full border border-black/10 px-4 py-2 font-medium hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
        >
          Admin
        </Link>
        <a
          href="/api/health"
          className="rounded-full border border-black/10 px-4 py-2 font-medium hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
        >
          Health check
        </a>
      </div>
    </main>
  );
}
