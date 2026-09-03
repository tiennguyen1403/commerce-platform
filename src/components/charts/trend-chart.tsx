import { type ReactNode } from "react";
import { type RevenueTimeSeriesPoint } from "@/server/services/analytics.service";
import { cn, formatMoney } from "@/lib/utils";
import {
  seriesPeak,
  seriesToPoints,
  toAreaPath,
  toBars,
  toLinePath,
} from "@/lib/chart";

/**
 * Hand-rolled inline-SVG trend charts for the admin analytics pages (#107): a
 * revenue area+line and an order-count bar chart, both plain Server Components
 * (no client JS, no charting library — see `@/lib/chart` for why). Colours come
 * only from theme tokens via Tailwind utilities, so both charts track light/dark
 * automatically:
 *   - revenue uses `--primary` (the one accent, tuned per theme for AA contrast);
 *   - order counts use `--chart-2`, the lightest neutral of the chart ramp that
 *     still clears the 3:1 non-text contrast floor against the card in BOTH
 *     themes (`--chart-1`/`--chart-5` are identical greys in light and dark and
 *     wash out at one extreme, so they're avoided).
 *
 * Accessibility: each chart is a `<figure>` whose `<svg>` is `aria-hidden` (a
 * screen reader gets nothing useful from raw path data) with the real data in an
 * `sr-only` `<table>`. When a visible data table already accompanies the chart on
 * the page, pass `decorative` — the whole figure is then hidden from assistive
 * tech to avoid announcing the same numbers twice.
 */

// A wide, short viewBox; `w-full` + `h-auto` make it fluid, and
// `vector-effect="non-scaling-stroke"` keeps strokes 1–2px at any rendered size.
const VIEW_W = 720;
// Headroom above the peak so a top-of-chart stroke isn't clipped at the edge.
const PAD_TOP = 6;
const DRAW_H = { compact: 96, full: 200 } as const;

type ChartSize = keyof typeof DRAW_H;

/** Format a `YYYY-MM-DD` UTC day key as a short `Mon D` label, in UTC — so the
 *  label never drifts to the neighbouring day in a negative-offset runtime TZ. */
function shortDay(dateKey: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${dateKey}T00:00:00Z`));
}

/** The visible date range of a series, e.g. "Aug 5 – Sep 3". */
function rangeLabel(points: RevenueTimeSeriesPoint[]): string {
  const first = points.at(0);
  const last = points.at(-1);
  if (!first || !last) return "";
  return `${shortDay(first.date)} – ${shortDay(last.date)}`;
}

/** Shared figure chrome: the SVG, a visible caption, and — unless `decorative` —
 *  an accessible name plus an `sr-only` data table. */
function ChartFigure({
  title,
  caption,
  decorative,
  table,
  children,
  className,
}: {
  title: string;
  caption: ReactNode;
  decorative?: boolean;
  table: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <figure
      className={cn("flex flex-col gap-2", className)}
      aria-label={decorative ? undefined : title}
      aria-hidden={decorative || undefined}
    >
      {children}
      <figcaption className="text-muted-foreground text-xs">
        {caption}
      </figcaption>
      {decorative ? null : (
        <table className="sr-only">
          <caption>{title}</caption>
          {table}
        </table>
      )}
    </figure>
  );
}

/** Net revenue per day as a filled area under a line. */
export function RevenueTrendChart({
  points,
  currency,
  size = "full",
  decorative,
  className,
}: {
  points: RevenueTimeSeriesPoint[];
  currency: string;
  size?: ChartSize;
  decorative?: boolean;
  className?: string;
}) {
  const drawH = DRAW_H[size];
  const viewH = drawH + PAD_TOP;
  const values = points.map((p) => p.netCents);
  const peak = seriesPeak(values);
  const coords = seriesToPoints(values, VIEW_W, drawH, peak);
  const total = values.reduce((sum, v) => sum + v, 0);
  const title = `Net revenue by day, ${points.length} days`;

  return (
    <ChartFigure
      title={title}
      decorative={decorative}
      className={className}
      caption={
        <span className="flex items-baseline justify-between gap-2">
          <span>Net revenue · {rangeLabel(points)} (UTC)</span>
          <span className="tabular-nums">{formatMoney(total, currency)}</span>
        </span>
      }
      table={
        <>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Gross</th>
              <th scope="col">Refunded</th>
              <th scope="col">Net</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.date}>
                <th scope="row">{p.date}</th>
                <td>{formatMoney(p.grossCents, currency)}</td>
                <td>{formatMoney(p.refundedCents, currency)}</td>
                <td>{formatMoney(p.netCents, currency)}</td>
              </tr>
            ))}
          </tbody>
        </>
      }
    >
      <svg
        viewBox={`0 0 ${VIEW_W} ${viewH}`}
        className="h-auto w-full overflow-visible"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <g transform={`translate(0, ${PAD_TOP})`}>
          <line
            x1={0}
            y1={drawH}
            x2={VIEW_W}
            y2={drawH}
            className="stroke-border"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          {peak > 0 ? (
            <>
              <path d={toAreaPath(coords, drawH)} className="fill-primary/15" />
              <path
                d={toLinePath(coords)}
                fill="none"
                className="stroke-primary"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </>
          ) : null}
        </g>
      </svg>
    </ChartFigure>
  );
}

/** Order count per day as bars. */
export function OrderCountChart({
  points,
  size = "full",
  decorative,
  className,
}: {
  points: RevenueTimeSeriesPoint[];
  size?: ChartSize;
  decorative?: boolean;
  className?: string;
}) {
  const drawH = DRAW_H[size];
  const viewH = drawH + PAD_TOP;
  const values = points.map((p) => p.orderCount);
  const bars = toBars(values, VIEW_W, drawH);
  const total = values.reduce((sum, v) => sum + v, 0);
  const title = `Orders by day, ${points.length} days`;

  return (
    <ChartFigure
      title={title}
      decorative={decorative}
      className={className}
      caption={
        <span className="flex items-baseline justify-between gap-2">
          <span>Orders · {rangeLabel(points)} (UTC)</span>
          <span className="tabular-nums">
            {total} {total === 1 ? "order" : "orders"}
          </span>
        </span>
      }
      table={
        <>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Orders</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.date}>
                <th scope="row">{p.date}</th>
                <td>{p.orderCount}</td>
              </tr>
            ))}
          </tbody>
        </>
      }
    >
      <svg
        viewBox={`0 0 ${VIEW_W} ${viewH}`}
        className="h-auto w-full overflow-visible"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <g transform={`translate(0, ${PAD_TOP})`}>
          <line
            x1={0}
            y1={drawH}
            x2={VIEW_W}
            y2={drawH}
            className="stroke-border"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          {bars.map((bar, i) => (
            <rect
              key={points[i]?.date ?? i}
              x={bar.x}
              y={bar.y}
              width={bar.width}
              height={bar.height}
              rx={1}
              className="fill-chart-2"
            />
          ))}
        </g>
      </svg>
    </ChartFigure>
  );
}
