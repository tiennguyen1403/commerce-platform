import { Skeleton } from "@/components/ui/skeleton";

/** Streamed fallback for the product grid — mirrors the card layout so the
 *  page doesn't shift when the real products arrive. Lives inside the list
 *  page's own <Suspense> (not a route-level loading.tsx) so it never wraps the
 *  PDP subtree, which must render non-streamed to return a real 404.
 *
 *  `role="status"` + `aria-live="polite"` + an `sr-only` label announce the
 *  loading state — the silent pulse divs alone told a screen-reader nothing. */
export function ProductGridSkeleton() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3"
    >
      <span className="sr-only">Loading products</span>
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
  );
}
