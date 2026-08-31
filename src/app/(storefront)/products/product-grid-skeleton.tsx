/** Streamed fallback for the product grid — mirrors the card layout so the
 *  page doesn't shift when the real products arrive. Lives inside the list
 *  page's own <Suspense> (not a route-level loading.tsx) so it never wraps the
 *  PDP subtree, which must render non-streamed to return a real 404. */
export function ProductGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="ring-foreground/10 overflow-hidden rounded-xl ring-1"
        >
          <div className="bg-muted aspect-square animate-pulse" />
          <div className="flex flex-col gap-2 p-4">
            <div className="bg-muted h-5 w-3/4 animate-pulse rounded-md" />
            <div className="bg-muted h-4 w-1/3 animate-pulse rounded-md" />
          </div>
        </div>
      ))}
    </div>
  );
}
