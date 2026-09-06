import { describe, it, expect } from "vitest";
import { paginationRange, ELLIPSIS } from "@/lib/pagination";

describe("paginationRange", () => {
  it("returns a single page when there is only one", () => {
    expect(paginationRange(1, 1)).toEqual([1]);
  });

  it("lists every page with no ellipsis when the set is small", () => {
    expect(paginationRange(3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(paginationRange(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(paginationRange(5, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("lists every page up to the small-set threshold, then windows", () => {
    expect(paginationRange(1, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(paginationRange(7, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // 8 pages exceeds the 7-slot threshold → the window collapses.
    expect(paginationRange(1, 8)).toEqual([1, 2, ELLIPSIS, 8]);
  });

  it("shows a lone hidden page instead of an equal-width ellipsis", () => {
    // The gap between 1 and the window is a single page (2) — render it, not `…`.
    expect(paginationRange(4, 8)).toEqual([1, 2, 3, 4, 5, ELLIPSIS, 8]);
  });

  it("collapses a right-side gap of two or more pages to an ellipsis", () => {
    expect(paginationRange(1, 10)).toEqual([1, 2, ELLIPSIS, 10]);
    expect(paginationRange(2, 10)).toEqual([1, 2, 3, ELLIPSIS, 10]);
  });

  it("collapses a left-side gap when the current page is near the end", () => {
    expect(paginationRange(10, 10)).toEqual([1, ELLIPSIS, 9, 10]);
    expect(paginationRange(9, 10)).toEqual([1, ELLIPSIS, 8, 9, 10]);
  });

  it("collapses both sides when the current page is in the middle", () => {
    expect(paginationRange(8, 40)).toEqual([
      1,
      ELLIPSIS,
      7,
      8,
      9,
      ELLIPSIS,
      40,
    ]);
  });

  it("always includes the first, last, and current pages", () => {
    for (const [current, total] of [
      [1, 1],
      [1, 2],
      [4, 7],
      [8, 40],
      [40, 40],
    ] as const) {
      const items = paginationRange(current, total);
      expect(items).toContain(1);
      expect(items).toContain(total);
      expect(items).toContain(current);
    }
  });

  it("respects a wider sibling window", () => {
    expect(paginationRange(8, 40, 2)).toEqual([
      1,
      ELLIPSIS,
      6,
      7,
      8,
      9,
      10,
      ELLIPSIS,
      40,
    ]);
  });

  it("clamps a fiddled current page into range", () => {
    // Past the end, before the start, and non-integer all resolve cleanly.
    expect(paginationRange(999, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(paginationRange(0, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(paginationRange(-3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(paginationRange(3.7, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("floors a non-positive total to a single page", () => {
    expect(paginationRange(1, 0)).toEqual([1]);
    expect(paginationRange(1, -10)).toEqual([1]);
  });
});
