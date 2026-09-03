import { describe, it, expect } from "vitest";
import {
  seriesPeak,
  seriesToPoints,
  toLinePath,
  toAreaPath,
  toBars,
} from "@/lib/chart";

describe("seriesPeak", () => {
  it.each([
    [[1, 5, 3], 5],
    [[0, 0, 0], 0],
    [[], 0],
    [[42], 42],
    [[-2, -5], 0], // floored at 0 — series here are non-negative, but the guard holds
  ])("peak of %j is %i", (values, expected) => {
    expect(seriesPeak(values)).toBe(expected);
  });
});

describe("seriesToPoints", () => {
  it("maps the peak to the top (y=0) and a zero to the baseline (y=height)", () => {
    expect(seriesToPoints([0, 5, 10], 100, 50)).toEqual([
      { x: 0, y: 50 },
      { x: 50, y: 25 },
      { x: 100, y: 0 },
    ]);
  });

  it("spaces points evenly across the full width", () => {
    const xs = seriesToPoints([1, 1, 1, 1, 1], 80, 40).map((p) => p.x);
    expect(xs).toEqual([0, 20, 40, 60, 80]);
  });

  it("honours an explicit max so a value below it does not reach the top", () => {
    expect(seriesToPoints([5], 100, 50, 10)).toEqual([{ x: 50, y: 25 }]);
  });

  it("centres a single point horizontally (no segment to span)", () => {
    expect(seriesToPoints([7], 100, 50)).toEqual([{ x: 50, y: 0 }]);
  });

  it("collapses an all-zero window onto the baseline — no divide-by-zero", () => {
    const points = seriesToPoints([0, 0, 0], 100, 50);
    expect(points).toEqual([
      { x: 0, y: 50 },
      { x: 50, y: 50 },
      { x: 100, y: 50 },
    ]);
    expect(points.every((p) => Number.isFinite(p.y))).toBe(true);
  });

  it("returns [] for an empty series", () => {
    expect(seriesToPoints([], 100, 50)).toEqual([]);
  });
});

describe("toLinePath", () => {
  it("emits M for the first point and L for the rest", () => {
    expect(
      toLinePath([
        { x: 0, y: 50 },
        { x: 50, y: 25 },
        { x: 100, y: 0 },
      ]),
    ).toBe("M0,50 L50,25 L100,0");
  });

  it("emits a lone M for a single point", () => {
    expect(toLinePath([{ x: 50, y: 0 }])).toBe("M50,0");
  });

  it("returns '' for no points", () => {
    expect(toLinePath([])).toBe("");
  });
});

describe("toAreaPath", () => {
  it("closes the line down to the baseline and back", () => {
    expect(
      toAreaPath(
        [
          { x: 0, y: 50 },
          { x: 100, y: 0 },
        ],
        50,
      ),
    ).toBe("M0,50 L100,0 L100,50 L0,50 Z");
  });

  it("returns '' for no points", () => {
    expect(toAreaPath([], 50)).toBe("");
  });
});

describe("toBars", () => {
  it("centres each bar in its slot and grows it up from the baseline", () => {
    expect(toBars([0, 10], 100, 50)).toEqual([
      { x: 7.5, y: 50, width: 35, height: 0 },
      { x: 57.5, y: 0, width: 35, height: 50 },
    ]);
  });

  it("fills the whole slot when gap is 0", () => {
    expect(toBars([10], 100, 50, 10, 0)).toEqual([
      { x: 0, y: 0, width: 100, height: 50 },
    ]);
  });

  it("scales bar heights against an explicit max", () => {
    const [bar] = toBars([5], 100, 50, 10, 0);
    expect(bar.height).toBe(25);
    expect(bar.y).toBe(25);
  });

  it("yields zero-height bars for an all-zero window — no divide-by-zero", () => {
    const bars = toBars([0, 0], 100, 50);
    expect(bars.every((b) => b.height === 0 && b.y === 50)).toBe(true);
    expect(bars.every((b) => Number.isFinite(b.height))).toBe(true);
  });

  it("returns [] for an empty series", () => {
    expect(toBars([], 100, 50)).toEqual([]);
  });
});
