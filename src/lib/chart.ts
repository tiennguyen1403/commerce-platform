/**
 * Pure geometry helpers for the hand-rolled inline-SVG charts on the admin
 * analytics pages (#107). No React, no DOM, no charting library — value arrays
 * in, SVG coordinate strings / rectangles out — so they unit-test in isolation
 * and the `trend-chart` server component stays declarative. We hand-roll these
 * because Recharts needs a React 19 `react-is` override, is client-only, and
 * pulls in ~50KB for two small charts (docs/milestones/M3-platform/research.md).
 *
 * Convention: the SVG y-axis grows downward (0 at the top), so a LARGER value
 * maps to a SMALLER y. Every series here is non-negative (revenue cents and
 * order counts), and each function treats an all-zero (or empty-driven) window —
 * peak 0 — as a flat line on the baseline rather than dividing by zero.
 */

/** A point in SVG user-space units. */
export type ChartPoint = { x: number; y: number };

/** A single bar's rectangle in SVG user-space units. */
export type ChartBar = { x: number; y: number; width: number; height: number };

// Coordinates are rounded to two decimals to keep the emitted path/rect strings
// compact and the server-rendered DOM stable; sub-0.01-unit precision is
// invisible at any real chart size.
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The largest value in the series, floored at 0 (never negative) — the scale
 * denominator. Exposed so sibling series can share one peak for a common scale.
 * An empty series has peak 0.
 */
export function seriesPeak(values: number[]): number {
  return values.reduce((max, v) => (v > max ? v : max), 0);
}

/**
 * Map a series of non-negative values to evenly-spaced points across a
 * `width`×`height` box: the peak maps to `y = 0` (top), a zero value to
 * `y = height` (baseline). Pass an explicit `max` to pin the scale (e.g. to
 * share an axis across series); it defaults to the series' own peak.
 *
 * An all-zero peak collapses every point onto the baseline instead of dividing
 * by zero. A single point is centred horizontally (there is no segment to span).
 */
export function seriesToPoints(
  values: number[],
  width: number,
  height: number,
  max: number = seriesPeak(values),
): ChartPoint[] {
  const lastIndex = values.length - 1;
  return values.map((value, i) => {
    const x = lastIndex <= 0 ? width / 2 : (i / lastIndex) * width;
    const y = max <= 0 ? height : height - (value / max) * height;
    return { x: round(x), y: round(y) };
  });
}

/** Build an SVG polyline `d` from points: `M x,y L x,y …`. Empty points → "". */
export function toLinePath(points: ChartPoint[]): string {
  if (points.length === 0) return "";
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
}

/**
 * Build a closed `d` for the filled region under the line: the polyline, then
 * down to the baseline at the last x, across to the first x, and closed. `height`
 * must be the same baseline y used to build the points. Empty points → "".
 */
export function toAreaPath(points: ChartPoint[], height: number): string {
  if (points.length === 0) return "";
  const first = points[0];
  const last = points[points.length - 1];
  return `${toLinePath(points)} L${last.x},${round(height)} L${first.x},${round(height)} Z`;
}

/**
 * Lay out one bar per value across a `width`×`height` box. Each value gets an
 * equal slot; the bar fills `(1 - gap)` of its slot, centred, and grows up from
 * the baseline. `gap` is the fraction of a slot left as spacing (0–1). An
 * all-zero peak yields zero-height bars (nothing drawn) rather than dividing by
 * zero. Empty values → [].
 */
export function toBars(
  values: number[],
  width: number,
  height: number,
  max: number = seriesPeak(values),
  gap = 0.3,
): ChartBar[] {
  const n = values.length;
  if (n === 0) return [];
  const slot = width / n;
  const barWidth = slot * (1 - gap);
  const offset = (slot - barWidth) / 2;
  return values.map((value, i) => {
    const barHeight = max <= 0 ? 0 : (value / max) * height;
    return {
      x: round(i * slot + offset),
      y: round(height - barHeight),
      width: round(barWidth),
      height: round(barHeight),
    };
  });
}
