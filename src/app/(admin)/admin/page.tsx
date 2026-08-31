import Link from "next/link";

export default function AdminHome() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col justify-center gap-4 px-6 py-24">
      <h1 className="text-3xl font-semibold tracking-tight">Admin</h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        Dashboard, catalog, and orders land here in Phase 1–2.
      </p>
      <Link
        href="/"
        className="text-sm font-medium underline underline-offset-4"
      >
        ← Back to storefront
      </Link>
    </main>
  );
}
