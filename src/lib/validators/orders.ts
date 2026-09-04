import { z } from "zod";

/**
 * Order presentation + input schemas — the client-safe source of truth for order
 * status labels/badges (shared by the admin list, detail, and the action UI) and
 * the list page's search-param parsing. Pure zod only: imported by client
 * components, so it must never pull in a `server-only` module.
 *
 * The status set is redefined here (not imported from `@prisma/client`) so this
 * file stays free of the Prisma runtime — mirroring `PRODUCT_STATUSES` in
 * `catalog.ts`. The string union matches Prisma's `OrderStatus` enum exactly, so
 * a parsed value is assignable where the repository wants an `OrderStatus`.
 */

export const ORDER_STATUSES = [
  "PENDING",
  "PAID",
  "FULFILLED",
  "CANCELLED",
  "REFUNDED",
] as const;
export type OrderStatusValue = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_LABELS: Record<OrderStatusValue, string> = {
  PENDING: "Pending",
  PAID: "Paid",
  FULFILLED: "Fulfilled",
  CANCELLED: "Cancelled",
  REFUNDED: "Refunded",
};

/** Badge variant per status. Colour is secondary to the always-visible label:
 *  PAID leads with the accent (the money's in), PENDING is muted (awaiting),
 *  FULFILLED reads as a calm closed state, and the two terminal "no completed
 *  sale" states (CANCELLED / REFUNDED) share the destructive tint. */
export const ORDER_STATUS_BADGE: Record<
  OrderStatusValue,
  "default" | "secondary" | "destructive" | "outline"
> = {
  PENDING: "secondary",
  PAID: "default",
  FULFILLED: "outline",
  CANCELLED: "destructive",
  REFUNDED: "destructive",
};

/* -------------------------------------------------------------------------- *
 * Fulfillment status presentation (M4 #142)                                  *
 * -------------------------------------------------------------------------- */

/**
 * Our own closed fulfillment state machine, redefined here as a string union for
 * the same reason `ORDER_STATUSES` is (see the file header): this module is
 * imported by client components, so it must stay free of the `@prisma/client`
 * runtime. The union matches Prisma's `FulfillmentStatus` enum exactly, so an
 * `order.fulfillmentStatus` value indexes the maps below directly.
 */
export const FULFILLMENT_STATUSES = [
  "NOT_SUBMITTED",
  "SUBMITTING",
  "SUBMITTED",
  "SHIPPED",
  "FAILED",
] as const;
export type FulfillmentStatusValue = (typeof FULFILLMENT_STATUSES)[number];

/** Admin-facing fulfillment labels — the operator sees our real internal state
 *  (the shopper gets the friendlier `shopperShipmentView` below instead). */
export const FULFILLMENT_STATUS_LABELS: Record<FulfillmentStatusValue, string> =
  {
    NOT_SUBMITTED: "Not submitted",
    SUBMITTING: "Submitting",
    SUBMITTED: "Submitted",
    SHIPPED: "Shipped",
    FAILED: "Failed",
  };

/** Badge variant per fulfillment status (admin detail). The always-visible label
 *  leads; colour is secondary: SUBMITTED carries the accent (in the provider's
 *  hands), SHIPPED reads as the calm closed state, FAILED takes the destructive
 *  tint, and the two pre-provider states (NOT_SUBMITTED / SUBMITTING) stay muted.
 *  A *stuck* SUBMITTING is surfaced as needs-attention by `fulfillmentAttention`,
 *  not by the badge colour. */
export const FULFILLMENT_STATUS_BADGE: Record<
  FulfillmentStatusValue,
  "default" | "secondary" | "destructive" | "outline"
> = {
  NOT_SUBMITTED: "secondary",
  SUBMITTING: "secondary",
  SUBMITTED: "default",
  SHIPPED: "outline",
  FAILED: "destructive",
};

/** An operator-facing "needs attention" callout for the admin order detail:
 *  a short title + one explanatory line. */
export type FulfillmentAttention = { title: string; description: string };

/**
 * Whether — and why — an order's fulfillment needs an operator's attention on the
 * admin detail page, or null when it's progressing normally. Three cases, in
 * precedence order:
 *  - FAILED — the provider rejected the order or submit attempts were exhausted;
 *    it won't ship without a manual fulfilment or a refund.
 *  - SUBMITTING — the state is meant to be transient (claimed → submitted within
 *    one outbox-drain tick). An order still SUBMITTING is a lost worker part-way
 *    through submission, and the order-level SUBMITTING guard (M4 #139) never
 *    retries it automatically — a human must reconcile it.
 *  - `stuckAt` set — a SUBMITTED shipment the poll cron flagged as open past the
 *    age threshold (a provider hold like `onhold`/`inreview` that isn't resolving,
 *    M4 #155). It's still polled (it may yet ship), but it's worth a look.
 * Pure and client-safe (takes the raw `fulfillmentStatus` + nullable `stuckAt`),
 * so it's unit-testable and the admin page just renders the result.
 */
export function fulfillmentAttention(
  status: FulfillmentStatusValue,
  stuckAt: Date | null,
): FulfillmentAttention | null {
  if (status === "FAILED") {
    return {
      title: "Fulfillment failed",
      description:
        "The provider rejected this order or submission attempts were exhausted. It won’t ship on its own — fulfil it manually or refund the shopper.",
    };
  }
  if (status === "SUBMITTING") {
    return {
      title: "Stuck part-way through submission",
      description:
        "A submission started but never confirmed. It won’t retry automatically — reconcile with the provider before re-attempting, so the order isn’t submitted twice.",
    };
  }
  if (stuckAt) {
    return {
      title: "Shipment open longer than expected",
      description:
        "The provider accepted this order but hasn’t shipped it within the expected window — it may be on hold or in review. Check the provider dashboard.",
    };
  }
  return null;
}

/** A shopper-facing view of an order's shipment for the account detail page. */
export type ShopperShipmentView = { label: string; description: string };

/**
 * A shopper-friendly view of an order's shipment — a short label + one line —
 * derived from the order + fulfillment status, deliberately hiding our internal
 * vocabulary (SUBMITTING, provider ids) and never alarming the shopper about an
 * operator-side FAILED (which a refund or manual fulfilment resolves). Returns
 * null when there's no shipment story to tell — the order-status badge already
 * conveys pending / cancelled / refunded, so the account page shows the shipping
 * card only for an order that's shipped or on its way.
 */
export function shopperShipmentView(
  orderStatus: OrderStatusValue,
  fulfillmentStatus: FulfillmentStatusValue,
): ShopperShipmentView | null {
  // The order-status badge already tells the whole story for these — no separate
  // shipment line (and, on the page, no shipping card unless tracking is present).
  if (
    orderStatus === "PENDING" ||
    orderStatus === "CANCELLED" ||
    orderStatus === "REFUNDED"
  ) {
    return null;
  }
  // Shipped — provider-confirmed (SHIPPED) or a manual FULFILLED override. Both
  // mean "on its way"; the tracking block (when present) renders below this line.
  if (fulfillmentStatus === "SHIPPED" || orderStatus === "FULFILLED") {
    return { label: "Shipped", description: "Your order is on its way." };
  }
  // PAID and not yet shipped. NOT_SUBMITTED / SUBMITTING / SUBMITTED all read as
  // "we're getting it ready"; a FAILED here is an operator concern (a refund or
  // manual fulfilment follows), never surfaced to the shopper as a dead-end.
  return {
    label: "Preparing your order",
    description:
      "We’re getting your order ready to ship. Tracking will appear here once it’s on its way.",
  };
}

/** The nullable `ship*` columns a shipping-address block reads — a structural
 *  subset of an order row, so this client-safe module needn't import the server
 *  `OrderWithItems` type. */
export type ShippingAddressColumns = {
  shipName: string | null;
  shipLine1: string | null;
  shipLine2: string | null;
  shipCity: string | null;
  shipState: string | null;
  shipPostalCode: string | null;
  shipCountry: string | null;
};

let regionNames: Intl.DisplayNames | null | undefined;

/** Expand an ISO-3166 alpha-2 country code to a readable name ("US" → "United
 *  States"), falling back to the raw (trimmed) code for a blank or unrecognised
 *  value. `Intl.DisplayNames` is available in every runtime this renders in
 *  (Node + the browser) but throws on a structurally invalid code and may be
 *  absent in an exotic one — both absorbed so display never errors a page. */
export function formatCountry(code: string): string {
  const trimmed = code.trim();
  if (!trimmed) return "";
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      regionNames = null;
    }
  }
  try {
    return regionNames?.of(trimmed.toUpperCase()) ?? trimmed;
  } catch {
    return trimmed;
  }
}

/**
 * Build a shipping address as display lines in postal order, skipping any absent
 * field — name / line1 / line2? / "city, state postal" / country (the code
 * expanded to a readable name). Mirrors the shipping-confirmation email's
 * `shippingAddressLines` ordering. An empty array means "no address on this
 * order" (a guest/legacy order), so the caller omits the section.
 */
export function formatShippingAddressLines(
  a: ShippingAddressColumns,
): string[] {
  const cityRegion = [a.shipCity, a.shipState]
    .map((v) => v?.trim())
    .filter((v): v is string => !!v)
    .join(", ");
  const cityLine = [cityRegion, a.shipPostalCode?.trim()]
    .filter((v): v is string => !!v)
    .join(" ");
  return [
    a.shipName?.trim() ?? "",
    a.shipLine1?.trim() ?? "",
    a.shipLine2?.trim() ?? "",
    cityLine,
    a.shipCountry ? formatCountry(a.shipCountry) : "",
  ].filter((v) => v.length > 0);
}

/**
 * A tracking URL safe to use as an `href` — the provider-supplied value only when
 * it's an http(s) URL, else null. Mirrors the shipping-confirmation email's gate
 * (`/^https?:\/\//i`): a missing, relative, or non-web value (a `javascript:` or
 * `data:` scheme) degrades to plain carrier/number text rather than an unsafe or
 * broken link.
 */
export function trackingHref(url: string | null | undefined): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

/**
 * Parse the admin orders list's URL search params into a clean, tenant-safe
 * query. Forgiving by design (`.catch`): a bad/absent `status` falls back to
 * "all", and a bad/absent `page` to 1 — a mistyped query string should render
 * the default view, never error a page an admin is just browsing. `pageSize` is
 * a server constant, not user input, so it isn't parsed here.
 */
export const listOrdersParamsSchema = z.object({
  status: z.enum(ORDER_STATUSES).optional().catch(undefined),
  page: z.coerce.number().int().positive().catch(1),
});

export type ListOrdersParamsInput = z.infer<typeof listOrdersParamsSchema>;

/**
 * Parse the shopper account order-history list's URL search params (#104). Only
 * `page` is user-controlled — a shopper's list has no status filter (they see
 * all their own orders) — and forgiving like `listOrdersParamsSchema`, so a
 * mistyped `?page` renders page 1 rather than erroring. `pageSize` is a server
 * constant, not parsed here.
 */
export const accountOrdersParamsSchema = z.object({
  page: z.coerce.number().int().positive().catch(1),
});

export type AccountOrdersParamsInput = z.infer<
  typeof accountOrdersParamsSchema
>;

/** Discriminated result every order lifecycle Server Action returns to the
 *  client (cancel / fulfil / refund). No payload on success — the client just
 *  refreshes the server-rendered detail to reflect the new status. */
export type OrderActionResult = { ok: true } | { ok: false; error: string };
