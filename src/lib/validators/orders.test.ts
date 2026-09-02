import { describe, it, expect } from "vitest";
import {
  ORDER_STATUS_BADGE,
  ORDER_STATUS_LABELS,
  ORDER_STATUSES,
  listOrdersParamsSchema,
} from "@/lib/validators/orders";

/**
 * The orders list search-param schema is deliberately forgiving: a mistyped
 * ?status or ?page must render the default view, never error a page an admin is
 * just browsing. These pin that behaviour (bad input falls back, good input
 * passes through) and that every status has a label + badge.
 */

describe("listOrdersParamsSchema", () => {
  it("defaults to no status filter and page 1 when nothing is given", () => {
    expect(listOrdersParamsSchema.parse({})).toEqual({
      status: undefined,
      page: 1,
    });
  });

  it("passes a valid status and coerces the page number", () => {
    expect(listOrdersParamsSchema.parse({ status: "PAID", page: "3" })).toEqual(
      { status: "PAID", page: 3 },
    );
  });

  it("accepts every order status", () => {
    for (const status of ORDER_STATUSES) {
      expect(listOrdersParamsSchema.parse({ status }).status).toBe(status);
    }
  });

  it("falls back to no filter for an unknown status", () => {
    expect(listOrdersParamsSchema.parse({ status: "SHIPPED" }).status).toBe(
      undefined,
    );
  });

  it("falls back to no filter when status is repeated (an array)", () => {
    expect(
      listOrdersParamsSchema.parse({ status: ["PAID", "PENDING"] }).status,
    ).toBe(undefined);
  });

  it.each(["0", "-1", "abc", "2.5", ""])(
    "falls back to page 1 for a non-positive-int page %j",
    (page) => {
      expect(listOrdersParamsSchema.parse({ page }).page).toBe(1);
    },
  );

  it("falls back to page 1 when page is repeated (an array)", () => {
    expect(listOrdersParamsSchema.parse({ page: ["2", "3"] }).page).toBe(1);
  });
});

describe("order status presentation maps", () => {
  it("has a label for every status", () => {
    for (const status of ORDER_STATUSES) {
      expect(ORDER_STATUS_LABELS[status]).toBeTruthy();
    }
  });

  it("has a badge variant for every status", () => {
    for (const status of ORDER_STATUSES) {
      expect(ORDER_STATUS_BADGE[status]).toBeTruthy();
    }
  });
});
