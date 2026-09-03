import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Search, SearchX } from "lucide-react";
import { getStoreTenant } from "@/server/store-context";
import { catalogService } from "@/server/services/catalog.service";
import { searchProductsParamsSchema } from "@/lib/validators/catalog";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { ProductCard } from "../products/product-card";
import { SearchForm } from "./search-form";

// Reads `searchParams` (and the tenant via headers) → dynamic. Keep it explicit
// so the DB-less CI build never attempts to prerender this per-request page
// (mirrors /products and /account/orders).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Search",
  description: "Search the catalog.",
};

// How many results per page. A server constant, not user input — only `q` and
// `page` are controlled by the URL (see `searchProductsParamsSchema`). 12 fills
// the 1/2/3-column grid cleanly.
const PAGE_SIZE = 12;

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // Forgiving parse: a fiddled ?q/?page renders a clean view, never errors.
  const { q, page } = searchProductsParamsSchema.parse(await searchParams);
  const { tenantId, currency } = await getStoreTenant();

  // Only hit the DB for a real query. An empty `q` renders the prompt instead —
  // distinct from a query that ran and simply matched nothing (both would return
  // the same `{ products: [], total: 0 }` from the repository, so the branch is
  // on the parsed query, never the result).
  const result = q
    ? await catalogService.searchStorefrontProducts(tenantId, {
        query: q,
        page,
        pageSize: PAGE_SIZE,
      })
    : null;

  const totalPages = result
    ? Math.max(1, Math.ceil(result.total / PAGE_SIZE))
    : 1;

  // Preserve the query across pages; page 1 stays implicit for a clean URL.
  const searchHref = (target: number) => {
    const sp = new URLSearchParams({ q });
    if (target > 1) sp.set("page", String(target));
    return `/search?${sp.toString()}`;
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">Search</h1>
        <p className="text-muted-foreground">
          {result
            ? `${result.total} ${result.total === 1 ? "result" : "results"} for “${q}”`
            : "Find products across the shop."}
        </p>
      </header>

      {result === null ? (
        // Empty query: a prompt with the search box as the primary call-to-action.
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
            <Search className="text-muted-foreground size-8" aria-hidden />
            <div className="flex flex-col gap-1">
              <p className="font-medium">Search the catalog</p>
              <p className="text-muted-foreground text-sm">
                Find products by name or description.
              </p>
            </div>
            <SearchForm
              className="w-full max-w-sm"
              label="Search the catalog"
            />
          </CardContent>
        </Card>
      ) : result.total === 0 ? (
        // A real query that matched nothing — distinct from the empty prompt.
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <SearchX className="text-muted-foreground size-8" aria-hidden />
            <div className="flex flex-col gap-1">
              <p className="font-medium">No results for &ldquo;{q}&rdquo;</p>
              <p className="text-muted-foreground text-sm">
                Try a different term or check your spelling.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : result.products.length === 0 ? (
        // A page past the end (a fiddled ?page). total > 0, so offer a way back.
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="text-muted-foreground text-sm">
              No results on this page.
            </p>
            <Link
              href={searchHref(1)}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Back to first page
            </Link>
          </CardContent>
        </Card>
      ) : (
        <>
          <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {result.products.map((product) => (
              <li key={product.id}>
                <ProductCard product={product} currency={currency} />
              </li>
            ))}
          </ul>

          {totalPages > 1 ? (
            <div className="flex items-center justify-between gap-4">
              <p className="text-muted-foreground text-sm">
                Page {page} of {totalPages}
              </p>
              <div className="flex gap-2">
                <PageLink href={searchHref(page - 1)} disabled={page <= 1}>
                  <ChevronLeft aria-hidden />
                  Previous
                </PageLink>
                <PageLink
                  href={searchHref(page + 1)}
                  disabled={page >= totalPages}
                >
                  Next
                  <ChevronRight aria-hidden />
                </PageLink>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** A prev/next control: a real link when in range, an inert disabled-looking
 *  span at the bounds (so there's nothing to click past the ends). */
function PageLink({
  href,
  disabled,
  children,
}: {
  href: string;
  disabled: boolean;
  children: ReactNode;
}) {
  const className = buttonVariants({ variant: "outline", size: "sm" });
  if (disabled) {
    return (
      <span
        aria-disabled="true"
        className={cn(className, "pointer-events-none opacity-50")}
      >
        {children}
      </span>
    );
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
