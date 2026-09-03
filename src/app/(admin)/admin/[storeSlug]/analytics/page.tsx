import type { Metadata } from "next";
import { requireAdminContext } from "@/server/auth/admin-context";
import { analyticsService } from "@/server/services/analytics.service";
import { formatMoney } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  OrderCountChart,
  RevenueTrendChart,
} from "@/components/charts/trend-chart";

export const metadata: Metadata = { title: "Analytics" };

export default async function AnalyticsPage({
  params,
}: {
  params: Promise<{ storeSlug: string }>;
}) {
  const { storeSlug } = await params;
  // Reuses the layout's cached admin context — no second DB round-trip. STAFF is
  // already the floor for the whole /admin subtree (requireAdminContext refuses
  // anyone below it), so analytics needs no extra role gate.
  const { tenantId, tenantName, currency } =
    await requireAdminContext(storeSlug);
  const series = await analyticsService.getRevenueTimeSeries(tenantId);

  // Window totals for the two headline figures above the charts.
  const totals = series.reduce(
    (acc, p) => ({
      grossCents: acc.grossCents + p.grossCents,
      refundedCents: acc.refundedCents + p.refundedCents,
      netCents: acc.netCents + p.netCents,
      orderCount: acc.orderCount + p.orderCount,
    }),
    { grossCents: 0, refundedCents: 0, netCents: 0, orderCount: 0 },
  );
  const revenueHint =
    totals.grossCents === 0
      ? undefined
      : totals.refundedCents > 0
        ? `Gross ${formatMoney(totals.grossCents, currency)} · less ${formatMoney(
            totals.refundedCents,
            currency,
          )} refunded`
        : "No refunds";

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="text-muted-foreground text-sm">
          Revenue and order volume for {tenantName} over the last{" "}
          {series.length} days (UTC).
        </p>
      </div>

      {/* Revenue over time. The chart is decorative here — the daily breakdown
          table below is the accessible source of the same numbers. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Net revenue</h2>
        <Card>
          <CardHeader>
            <CardDescription>
              Net revenue · last {series.length} days
            </CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums">
              {formatMoney(totals.netCents, currency)}
            </CardTitle>
            {revenueHint ? (
              <p className="text-muted-foreground text-xs tabular-nums">
                {revenueHint}
              </p>
            ) : null}
          </CardHeader>
          <CardContent>
            <RevenueTrendChart points={series} currency={currency} decorative />
          </CardContent>
        </Card>
      </section>

      {/* Order volume over time. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Order volume</h2>
        <Card>
          <CardHeader>
            <CardDescription>
              Orders · last {series.length} days
            </CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums">
              {totals.orderCount}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <OrderCountChart points={series} decorative />
          </CardContent>
        </Card>
      </section>

      {/* Daily breakdown — the accessible data table for both charts above. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight">
          Daily breakdown
        </h2>
        <Card className="py-0">
          <Table>
            <TableCaption className="sr-only">
              Daily gross, refunded, and net revenue with order counts over the
              last {series.length} days (UTC).
            </TableCaption>
            <TableHeader>
              {/* This table is the sole accessible data source on the page — the
                  two charts above are decorative (aria-hidden) — so each column
                  header carries an explicit `scope` for assistive tech. */}
              <TableRow>
                <TableHead scope="col">Date (UTC)</TableHead>
                <TableHead scope="col" className="text-right">
                  Gross
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Refunded
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Net
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Orders
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {series.map((p) => (
                <TableRow key={p.date}>
                  <TableCell className="font-medium tabular-nums">
                    {p.date}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(p.grossCents, currency)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.refundedCents > 0
                      ? `−${formatMoney(p.refundedCents, currency)}`
                      : formatMoney(0, currency)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(p.netCents, currency)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.orderCount}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </section>
    </div>
  );
}
