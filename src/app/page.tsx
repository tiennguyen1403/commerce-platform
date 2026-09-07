import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  ArrowRight,
  Check,
  CircleDot,
  LayoutDashboard,
  Layers,
  ShoppingCart,
  Store,
  Truck,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { LandingStage } from "./landing-stage";

/**
 * The platform's apex landing page — `/` on the app domain, the first screen a
 * visitor sees. Not a storefront screen: it renders under the root layout with
 * no tenant context, and a store host's `/` never reaches it (`src/proxy.ts`
 * sends a tenant root to `/products`). Fully static — no session, tenant, or DB
 * read — so it prerenders at build.
 *
 * Hierarchy (#215): one primary action, "Create your store", repeated in the
 * closing band; the demo store is the outline secondary; Admin and the health
 * check are quiet utilities in the top bar and footer. The four targets are the
 * same as before: `/new`, `/products`, `/admin`, `/api/health`.
 */

/** The status chip. Refresh at each milestone handoff (`/milestone-handoff`). */
const STATUS = "Milestone 7 · Storefront v2 up next";

const STACK = [
  "Next.js 16",
  "React 19",
  "TypeScript",
  "Tailwind v4",
  "Prisma",
  "PostgreSQL",
  "Better Auth",
  "Stripe",
  "Playwright",
];

/** The roadmap (`docs/milestones/README.md`); `active` marks the one up next. */
const MILESTONES: ReadonlyArray<{
  id: string;
  label: string;
  active?: boolean;
}> = [
  { id: "M0", label: "Foundations" },
  { id: "M1", label: "Commerce slice" },
  { id: "M2", label: "Production-grade" },
  { id: "M3", label: "Platform" },
  { id: "M4", label: "Fulfillment" },
  { id: "M5", label: "Product images" },
  { id: "M6", label: "UI redesign" },
  { id: "M7", label: "Storefront v2", active: true },
];

/** What is live, per surface — every line is a shipped capability. */
const PILLARS: ReadonlyArray<{
  icon: LucideIcon;
  title: string;
  lines: string[];
}> = [
  {
    icon: ShoppingCart,
    title: "Storefront",
    lines: [
      "Catalog with Postgres full-text search",
      "Cart and Stripe checkout, confirmed by webhook",
      "Shopper accounts with order history",
    ],
  },
  {
    icon: LayoutDashboard,
    title: "Admin",
    lines: [
      "Owner, admin and staff roles per store",
      "Products, variants and image uploads",
      "Orders, members, analytics and settings",
    ],
  },
  {
    icon: Truck,
    title: "Fulfillment",
    lines: [
      "Printful and mock adapters behind one provider interface",
      "Idempotent submission via a transactional outbox",
      "Polled tracking marks orders fulfilled",
    ],
  },
  {
    icon: Layers,
    title: "Platform",
    lines: [
      "Every query scoped by tenant",
      "A subdomain and an accent per store",
      "Typecheck, tests and Playwright E2E on every PR",
    ],
  },
];

export default function Home() {
  const year = new Date().getFullYear();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-2.5 md:px-6 md:py-3">
          <Link
            href="/"
            className="focus-visible:ring-ring/50 inline-flex items-center gap-2.5 rounded-md font-semibold tracking-tight outline-none focus-visible:ring-[3px]"
          >
            <span
              aria-hidden
              className="bg-accent text-primary flex size-8 shrink-0 items-center justify-center rounded-md"
            >
              <Store className="size-5" />
            </span>
            Commerce Platform
          </Link>
          <Button
            variant="ghost"
            nativeButton={false}
            render={<Link href="/admin" />}
          >
            <LayoutDashboard />
            Admin
          </Button>
        </div>
      </header>

      <main className="flex flex-1 flex-col">
        <section
          aria-labelledby="landing-title"
          className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-12 md:px-6 lg:grid-cols-[minmax(0,1fr)_568px] lg:items-center lg:gap-16 lg:py-16"
        >
          <div className="flex flex-col gap-6 lg:max-w-[520px]">
            <div className="flex flex-col gap-4">
              <span className="border-border text-muted-foreground inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium">
                <span
                  className="bg-primary size-1.5 rounded-full"
                  aria-hidden
                />
                {STATUS}
              </span>
              <h1
                id="landing-title"
                className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl"
              >
                Multi-tenant commerce platform
              </h1>
              <p className="text-muted-foreground max-w-xl text-lg leading-7 text-pretty">
                A production-grade storefront, admin, and fulfillment engine,
                built end-to-end. Each store is an isolated tenant on its own
                subdomain, so one codebase can run one shop or many.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
              <Button
                size="lg"
                nativeButton={false}
                render={<Link href="/new" />}
              >
                <Store />
                Create your store
              </Button>
              <Button
                size="lg"
                variant="outline"
                nativeButton={false}
                render={<Link href="/products" />}
              >
                Shop the store
                <ArrowRight />
              </Button>
            </div>
          </div>
          <LandingStage />
        </section>

        <section
          aria-labelledby="landing-live"
          className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 pb-16 md:px-6 lg:gap-7"
        >
          <div className="flex flex-col gap-2">
            <p className="text-primary text-xs font-medium tracking-wide uppercase">
              What&apos;s live
            </p>
            <h2
              id="landing-live"
              className="text-2xl font-semibold tracking-tight text-pretty sm:text-3xl"
            >
              The whole loop, from catalog to delivered order
            </h2>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:gap-4">
            {PILLARS.map(({ icon: Icon, title, lines }) => (
              <li key={title}>
                <Card className="h-full">
                  <CardContent className="flex flex-col gap-4">
                    <div className="flex flex-col gap-3">
                      <span className="bg-accent text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
                        <Icon className="size-5" aria-hidden />
                      </span>
                      <h3 className="text-base font-semibold tracking-tight">
                        {title}
                      </h3>
                    </div>
                    <ul className="text-muted-foreground flex flex-col gap-2">
                      {lines.map((line) => (
                        <li key={line} className="flex items-start gap-2">
                          <Check
                            className="text-primary mt-0.5 size-3.5 shrink-0"
                            aria-hidden
                          />
                          <span>{line}</span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        </section>

        <section
          aria-labelledby="landing-milestones"
          className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 pb-16 md:px-6"
        >
          <div className="flex flex-col gap-4 border-t pt-8">
            <h2
              id="landing-milestones"
              className="text-base font-semibold tracking-tight"
            >
              Shipped in milestones
            </h2>
            <ol className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:gap-x-8 sm:gap-y-4">
              {MILESTONES.map(({ id, label, active }) => (
                <li
                  key={id}
                  className="flex items-center gap-2.5 sm:items-start"
                >
                  {active ? (
                    <span className="border-primary text-primary flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed">
                      <CircleDot className="size-3" aria-hidden />
                    </span>
                  ) : (
                    <span className="bg-accent text-primary flex size-6 shrink-0 items-center justify-center rounded-full">
                      <Check className="size-3" aria-hidden />
                    </span>
                  )}
                  <span className="flex flex-col">
                    <span className="text-muted-foreground text-xs">
                      {id}
                      {active ? (
                        " · up next"
                      ) : (
                        <span className="sr-only"> · shipped</span>
                      )}
                    </span>
                    <span className="text-sm font-medium">{label}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
          <div className="flex flex-col gap-3">
            <h2 className="text-base font-semibold tracking-tight">
              Built with
            </h2>
            <ul className="flex flex-wrap gap-2">
              {STACK.map((item) => (
                <li
                  key={item}
                  className="bg-secondary text-secondary-foreground rounded-md px-2.5 py-1 text-sm"
                >
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section
          aria-labelledby="landing-cta"
          className="mx-auto w-full max-w-6xl px-4 pb-16 md:px-6 lg:pb-20"
        >
          <div className="bg-accent flex flex-col gap-5 rounded-2xl p-6 sm:p-8 lg:flex-row lg:items-center lg:justify-between lg:gap-8 lg:px-12 lg:py-10">
            <div className="flex max-w-xl flex-col gap-2">
              <h2
                id="landing-cta"
                className="text-2xl font-semibold tracking-tight text-pretty sm:text-3xl"
              >
                Start a store on its own subdomain.
              </h2>
              <p className="text-accent-foreground text-sm text-pretty sm:text-base">
                Name it, pick a subdomain, and it is live with its own admin,
                accent, and checkout.
              </p>
            </div>
            <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center">
              <Button
                size="lg"
                nativeButton={false}
                render={<Link href="/new" />}
              >
                <Store />
                Create your store
              </Button>
              <Button
                size="lg"
                variant="outline"
                nativeButton={false}
                render={<Link href="/products" />}
              >
                Shop the store
                <ArrowRight />
              </Button>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-start gap-2 px-4 py-5 sm:flex-row sm:items-center sm:justify-between md:px-6">
          <p className="text-muted-foreground text-sm">
            © {year} Commerce Platform
          </p>
          <Button
            variant="ghost"
            nativeButton={false}
            render={<a href="/api/health" />}
          >
            <Activity />
            Health check
          </Button>
        </div>
      </footer>
    </div>
  );
}
