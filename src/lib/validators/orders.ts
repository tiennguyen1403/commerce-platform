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
