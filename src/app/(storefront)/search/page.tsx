import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Search,
  SearchX,
} from "lucide-react";
import { getStoreTenant } from "@/server/store-context";
import { catalogService } from "@/server/services/catalog.service";
import { searchProductsParamsSchema } from "@/lib/validators/catalog";
import { paginationRange, ELLIPSIS } from "@/lib/pagination";
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
        {/* The header echoes the *query* (context); the how-many count lives in
            the results toolbar below — mirroring the /products listing, so the
            two catalog screens read as siblings. */}
        <p className="text-muted-foreground">
          {result ? (
            <>
              Results for{" "}
              <span className="text-foreground font-medium">
                &ldquo;{q}&rdquo;
              </span>
            </>
          ) : (
            "Find products across the shop."
          )}
        </p>
      </header>

      {result === null ? (
        // Empty query: a prompt with the search box as the primary call-to-action.
        <Card>
          <CardContent className="flex flex-col items-center gap-5 py-16 text-center">
            <span className="bg-muted text-muted-foreground flex size-14 items-center justify-center rounded-full">
              <Search className="size-7" aria-hidden />
            </span>
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
        // A real query that matched nothing — distinct from the empty prompt. The
        // house tinted-circle empty state, shared with /products and checkout.
        <Card>
          <CardContent className="flex flex-col items-center gap-5 py-16 text-center">
            <span className="bg-muted text-muted-foreground flex size-14 items-center justify-center rounded-full">
              <SearchX className="size-7" aria-hidden />
            </span>
            <div className="flex flex-col gap-1">
              <p className="font-medium">No results for &ldquo;{q}&rdquo;</p>
              <p className="text-muted-foreground text-sm">
                Try a different term or check your spelling.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : result.products.length === 0 ? (
        // A page past the end (a fiddled ?page). total > 0, so this is a
        // navigational dead-end, not an empty result — kept deliberately lighter
        // than the two hero empty states (no tinted circle) so it doesn't read as
        // "no results"; it just offers the way back.
        <Card>
          <CardContent className="flex flex-col items-center gap-5 py-16 text-center">
            <div className="flex flex-col gap-1">
              <p className="font-medium">Nothing on this page</p>
              <p className="text-muted-foreground text-sm">
                That page is past the last page of results.
              </p>
            </div>
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
          {/* Result-count toolbar on a hairline rule — the same idiom as the
              /products listing (right slot reserved via justify-between for a
              future real sort/filter, which would change the query and is out of
              scope for this UI-only pass). Rendered only here, in the non-empty
              branch, so "0 results" never surfaces. */}
          <div className="border-border flex items-center justify-between border-b pb-4 text-sm">
            <p className="text-muted-foreground tabular-nums">
              {result.total} {result.total === 1 ? "result" : "results"}
            </p>
          </div>

          <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {result.products.map((product, index) => (
              <li key={product.id}>
                <ProductCard
                  product={product}
                  currency={currency}
                  preload={index === 0}
                />
              </li>
            ))}
          </ul>

          {totalPages > 1 ? (
            <nav
              // The landmark name carries the summary the old textual "Page X of
              // Y" caption used to — an AT user hears it on entering the pager.
              aria-label={`Search results: page ${page} of ${totalPages}`}
              className="flex justify-center"
            >
              <ul className="flex flex-wrap items-center justify-center gap-1">
                <li>
                  <PageLink
                    href={searchHref(page - 1)}
                    disabled={page <= 1}
                    label="Previous page"
                  >
                    <ChevronLeft aria-hidden />
                    <span className="hidden sm:inline">Previous</span>
                  </PageLink>
                </li>

                {paginationRange(page, totalPages).map((item, index) =>
                  item === ELLIPSIS ? (
                    <li
                      key={`ellipsis-${index}`}
                      aria-hidden
                      className="text-muted-foreground flex size-7 items-center justify-center"
                    >
                      <MoreHorizontal className="size-4" />
                    </li>
                  ) : (
                    <li key={item}>
                      <PageNumber
                        href={searchHref(item)}
                        page={item}
                        current={item === page}
                      />
                    </li>
                  ),
                )}

                <li>
                  <PageLink
                    href={searchHref(page + 1)}
                    disabled={page >= totalPages}
                    label="Next page"
                  >
                    <span className="hidden sm:inline">Next</span>
                    <ChevronRight aria-hidden />
                  </PageLink>
                </li>
              </ul>
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}

/** A single numbered page control: a ghost link for the other pages, an inert
 *  outlined marker (`aria-current`) for the page you're on. */
function PageNumber({
  href,
  page,
  current,
}: {
  href: string;
  page: number;
  current: boolean;
}) {
  const className = cn(
    buttonVariants({ variant: current ? "outline" : "ghost", size: "icon-sm" }),
    "tabular-nums",
  );
  if (current) {
    return (
      <span
        aria-current="page"
        aria-label={`Page ${page}`}
        className={cn(className, "pointer-events-none")}
      >
        {page}
      </span>
    );
  }
  return (
    <Link href={href} aria-label={`Go to page ${page}`} className={className}>
      {page}
    </Link>
  );
}

/** A prev/next control: a real link when in range, an inert disabled-looking
 *  span at the bounds (so there's nothing to click past the ends). The visible
 *  label collapses on mobile, so `label` names the control for both cases. */
function PageLink({
  href,
  disabled,
  label,
  children,
}: {
  href: string;
  disabled: boolean;
  label: string;
  children: ReactNode;
}) {
  const className = buttonVariants({ variant: "outline", size: "sm" });
  if (disabled) {
    return (
      <span
        aria-disabled="true"
        aria-label={label}
        className={cn(className, "pointer-events-none opacity-50")}
      >
        {children}
      </span>
    );
  }
  return (
    <Link href={href} aria-label={label} className={className}>
      {children}
    </Link>
  );
}
