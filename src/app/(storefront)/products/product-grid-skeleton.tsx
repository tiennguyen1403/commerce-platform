import { Skeleton } from "@/components/ui/skeleton";

/** Streamed fallback for the product grid — mirrors the result-count toolbar
 *  and the card layout so the page doesn't shift when the real products arrive.
 *  Lives inside the list page's own <Suspense> (not a route-level loading.tsx)
 *  so it never wraps the PDP subtree, which must render non-streamed to return a
 *  real 404.
 *
 *  `role="status"` + `aria-live="polite"` + an `sr-only` label announce the
 *  loading state — the silent pulse divs alone told a screen-reader nothing. */
export function ProductGridSkeleton() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-5">
      <span className="sr-only">Loading products</span>
      {/* Mirrors the result-count toolbar in products/page.tsx (same classes, so
          the streamed swap lines up exactly). */}
      <div className="border-border flex items-center justify-between border-b pb-4 text-sm">
        <Skeleton className="h-5 w-24" />
      </div>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="ring-foreground/10 overflow-hidden rounded-xl ring-1"
          >
            <Skeleton className="aspect-square rounded-none" />
            <div className="flex flex-col gap-2 p-4">
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-4 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
