import type { LucideIcon } from "lucide-react";
import { Package, ShieldCheck, Truck, Zap } from "lucide-react";

/**
 * The auth "stage" — the store-side panel beside the sign-in / sign-up card
 * (M6-09 v2, Direction A of the "Auth Redesign v2" canvas).
 *
 * An accent surface: the per-tenant `--accent` tint (the storefront wrapper
 * re-parametrizes it by `Tenant.themeHue`, so every store gets its own stage)
 * with secondary copy in `--accent-foreground` — the token pairing that keeps
 * AA on every hue (the neutral muted grey only reaches ~4.25:1 on the tint).
 * The stage sells the store's promise (restating the footer's own copy); the
 * card beside it instructs — so the two never say the same sentence. Nothing
 * here is read from the DB.
 *
 * Responsive in one element: a full-bleed band under the header (headline +
 * line + trust cue only) up to `lg`, a rounded panel with the benefit list from
 * `lg` — at `md` the two-column grid would leave the stage a ~160px measure,
 * so the split waits for the 416px it gets at 1024px. The headline is display
 * text, not a heading: the card's `h1` stays the page's only heading.
 */
export function AuthStage({ ariaLabel }: { ariaLabel: string }) {
  return (
    <section
      aria-label={ariaLabel}
      className="bg-accent flex flex-col gap-3 px-4 py-6 lg:gap-8 lg:rounded-2xl lg:p-12"
    >
      <div className="flex flex-col gap-2 lg:gap-4">
        <p className="max-w-lg text-2xl font-semibold tracking-tight text-pretty lg:text-4xl">
          Made to order. Tracked to your door.
        </p>
        <p className="text-accent-foreground max-w-md text-sm text-pretty lg:text-base">
          Each order is printed when you place it, then tracked all the way to
          delivery.
        </p>
      </div>
      <ul className="hidden flex-col gap-4 lg:flex">
        <Benefit
          icon={Package}
          title="Track your orders"
          text="Every order and its status, in your account."
        />
        <Benefit
          icon={Zap}
          title="Check out faster"
          text="Fewer steps between your cart and the confirmation."
        />
        <Benefit
          icon={Truck}
          title="Made to order, shipped from the US"
          text="Printed by our print partner when you order."
        />
      </ul>
      <p className="text-accent-foreground inline-flex items-center gap-2 text-xs lg:text-sm">
        <ShieldCheck className="size-4 shrink-0" aria-hidden />
        Secure checkout with Stripe
      </p>
    </section>
  );
}

function Benefit({
  icon: Icon,
  title,
  text,
}: {
  icon: LucideIcon;
  title: string;
  text: string;
}) {
  return (
    <li className="flex items-start gap-3">
      {/* A white chip on the tint — the account cluster's chip idiom, inverted
          so it stays visible on the accent surface. */}
      <span className="bg-card ring-foreground/10 flex size-9 shrink-0 items-center justify-center rounded-lg ring-1">
        <Icon className="text-primary size-5" aria-hidden />
      </span>
      <div className="flex flex-col gap-0.5 pt-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-accent-foreground text-sm">{text}</p>
      </div>
    </li>
  );
}
