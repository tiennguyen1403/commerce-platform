/** Skeleton shown while an admin products route resolves its data on the
 *  server. Kept generic so it reads as "loading" for the list and the editor
 *  alike. */
export default function ProductsLoading() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-10">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-2">
          <div className="bg-muted h-7 w-32 animate-pulse rounded-md" />
          <div className="bg-muted h-4 w-48 animate-pulse rounded-md" />
        </div>
        <div className="bg-muted h-8 w-32 animate-pulse rounded-lg" />
      </div>
      <div className="bg-card ring-foreground/10 flex flex-col gap-3 rounded-xl p-4 ring-1">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="bg-muted h-9 w-full animate-pulse rounded-md"
          />
        ))}
      </div>
    </div>
  );
}
