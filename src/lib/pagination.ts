/**
 * Pagination helpers — pure presentation logic for a numbered pager. Kept out of
 * any Server Component so it can be unit-tested without pulling in server-only
 * modules, and reused by any paginated screen.
 */

/** A gap between page numbers, rendered as an ellipsis in the pager. */
export const ELLIPSIS = "ellipsis";

/** One rendered pager slot: a page number, or an `ELLIPSIS` gap marker. */
export type PaginationItem = number | typeof ELLIPSIS;

/**
 * The page numbers to render around `current`: always the first and last page,
 * plus a `siblingCount`-wide window around the current one, with `ELLIPSIS`
 * markers standing in for any wider gap. Compact for a large set (e.g. page 8 of
 * 40 → `1 … 7 8 9 … 40`) while never dropping the endpoints or the current page.
 * A small set is listed in full, and a gap of exactly one page is shown as that
 * page rather than an ellipsis of the same width (`1 2 3 4`, never `1 2 … 4`).
 *
 * Defensive on input so a fiddled `?page` can't produce a broken pager: `total`
 * is floored at 1 and `current` is clamped into `[1, total]`.
 */
export function paginationRange(
  current: number,
  total: number,
  siblingCount = 1,
): PaginationItem[] {
  const pageCount = Math.max(1, Math.floor(total));
  const page = Math.min(Math.max(1, Math.floor(current)), pageCount);
  const siblings = Math.max(0, Math.floor(siblingCount));

  // Small sets: list every page. First, last, the current page, both sibling
  // windows and two ellipses all fit within this many slots, so collapsing would
  // only trade a clear number for an ambiguous "…" of the same width.
  const maxSlots = 2 * siblings + 5;
  if (pageCount <= maxSlots) {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }

  // First, last, and the window around the current page — de-duplicated and
  // ordered. A Set collapses the overlaps at the ends (e.g. current === 1).
  const shown = new Set<number>([1, pageCount]);
  for (let offset = -siblings; offset <= siblings; offset++) {
    const candidate = page + offset;
    if (candidate >= 1 && candidate <= pageCount) shown.add(candidate);
  }

  const sorted = [...shown].sort((a, b) => a - b);
  const items: PaginationItem[] = [];
  let previous = 0;
  for (const value of sorted) {
    const gap = value - previous;
    if (gap === 2) {
      // Exactly one page hidden — show it rather than an equal-width ellipsis.
      items.push(previous + 1);
    } else if (gap > 2) {
      items.push(ELLIPSIS);
    }
    items.push(value);
    previous = value;
  }
  return items;
}
