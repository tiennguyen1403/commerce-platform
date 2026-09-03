import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { buttonVariants } from "@/components/ui/button";

/**
 * The storefront's catalog search: a plain GET form that navigates to
 * `/search?q=…` with a full-page request — no client JS, works with the browser
 * alone (submit on Enter or via the button). Rendered in the header (compact,
 * empty) and as the empty-query page's primary call-to-action (pre-fillable via
 * `defaultValue`).
 *
 * The submit control is a native `<button type="submit">` styled with
 * `buttonVariants` rather than the shadcn `Button` — the simplest element that
 * reliably submits, with no reliance on Base UI's prop-merge order for `type`
 * (Base UI only *defaults* a button's `type` to `"button"`; an explicit
 * `type="submit"` on its `Button` would override that and work too — the native
 * element is just simpler and pulls in no client-only primitive of its own).
 */
export function SearchForm({
  defaultValue,
  className,
  label = "Search products",
}: {
  defaultValue?: string;
  className?: string;
  /** Accessible name for the `role="search"` landmark. Pass a distinct value
   *  when two search forms can appear on one page (the header mount + the
   *  empty-query card) so the repeated landmark stays unambiguous. */
  label?: string;
}) {
  return (
    <form
      action="/search"
      method="GET"
      role="search"
      aria-label={label}
      className={cn("flex items-center gap-2", className)}
    >
      <Input
        type="search"
        name="q"
        defaultValue={defaultValue}
        placeholder="Search products…"
        aria-label="Search products"
        // Matches the server-side cap in `searchProductsParamsSchema`.
        maxLength={100}
        className="min-w-0 flex-1"
      />
      <button
        type="submit"
        aria-label="Search"
        className={cn(buttonVariants({ size: "icon" }), "shrink-0")}
      >
        <Search aria-hidden />
      </button>
    </form>
  );
}
