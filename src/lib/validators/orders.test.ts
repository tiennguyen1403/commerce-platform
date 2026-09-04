import { describe, it, expect } from "vitest";
import {
  FULFILLMENT_STATUS_BADGE,
  FULFILLMENT_STATUS_LABELS,
  FULFILLMENT_STATUSES,
  ORDER_STATUS_BADGE,
  ORDER_STATUS_LABELS,
  ORDER_STATUSES,
  type ShippingAddressColumns,
  formatCountry,
  formatShippingAddressLines,
  fulfillmentAttention,
  fulfillmentErrorAttention,
  listOrdersParamsSchema,
  shopperShipmentView,
  trackingHref,
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

describe("fulfillment status presentation maps", () => {
  it("has a label for every fulfillment status", () => {
    for (const status of FULFILLMENT_STATUSES) {
      expect(FULFILLMENT_STATUS_LABELS[status]).toBeTruthy();
    }
  });

  it("has a badge variant for every fulfillment status", () => {
    for (const status of FULFILLMENT_STATUSES) {
      expect(FULFILLMENT_STATUS_BADGE[status]).toBeTruthy();
    }
  });
});

describe("fulfillmentAttention", () => {
  it("flags a FAILED order as needing attention", () => {
    const attention = fulfillmentAttention("FAILED", null);
    expect(attention?.title).toBe("Fulfillment failed");
  });

  it("flags a stuck SUBMITTING order (a lost worker mid-submission)", () => {
    const attention = fulfillmentAttention("SUBMITTING", null);
    expect(attention?.title).toBe("Stuck part-way through submission");
  });

  it("flags a SUBMITTED order the poll cron marked stuck-open", () => {
    const attention = fulfillmentAttention("SUBMITTED", new Date());
    expect(attention?.title).toBe("Shipment open longer than expected");
  });

  it("does not flag a normally-progressing SUBMITTED order", () => {
    expect(fulfillmentAttention("SUBMITTED", null)).toBeNull();
  });

  it("does not flag a SHIPPED order that still carries a stale stuck marker", () => {
    // `fulfillmentStuckAt` is write-once and never cleared, so a shipment flagged
    // stuck (#155) that then ships still carries it. The banner must NOT fire on a
    // shipped order — otherwise it contradicts the order's own tracking.
    expect(fulfillmentAttention("SHIPPED", new Date())).toBeNull();
  });

  it.each(["NOT_SUBMITTED", "SHIPPED"] as const)(
    "does not flag a %s order",
    (status) => {
      expect(fulfillmentAttention(status, null)).toBeNull();
    },
  );

  it("prefers the FAILED message over a stuck marker (precedence)", () => {
    // A terminal FAILED is the operator's headline even if a stuck marker also
    // lingers on the row — the FAILED branch wins.
    const attention = fulfillmentAttention("FAILED", new Date());
    expect(attention?.title).toBe("Fulfillment failed");
  });
});

describe("fulfillmentErrorAttention", () => {
  it("flags a SUBMITTED open shipment whose tracking lookups are failing", () => {
    const attention = fulfillmentErrorAttention("SUBMITTED", 144);
    expect(attention?.title).toBe("Tracking lookups are failing");
    // Action-oriented copy that distinguishes it from a provider hold: the lookup
    // call itself is failing (unreadable), vs. a readable-but-held stuck shipment.
    expect(attention?.description).toContain("provider dashboard");
    expect(attention?.description).toContain(
      "the lookup call itself is erroring",
    );
  });

  it("clears once a clean poll resets the streak (count 0), order still SUBMITTED", () => {
    // `fulfillmentErrorCount` resets to 0 on any clean poll, so the surface clears
    // itself the moment tracking recovers — no write-once caveat (contrast the stuck
    // marker). This is the AC's "it clears when the streak resets" case.
    expect(fulfillmentErrorAttention("SUBMITTED", 0)).toBeNull();
  });

  it("scales the copy with the streak (singular vs. the exact count)", () => {
    // "Copy that scales": one failed lookup reads differently from a long streak, and
    // the count is surfaced verbatim so severity is self-evident.
    expect(fulfillmentErrorAttention("SUBMITTED", 1)?.description).toContain(
      "The last attempt",
    );
    const many = fulfillmentErrorAttention("SUBMITTED", 144)?.description;
    expect(many).toContain("The last 144 attempts");
  });

  it.each(["NOT_SUBMITTED", "SUBMITTING", "SHIPPED", "FAILED"] as const)(
    "does not flag a %s order even with a non-zero count",
    (status) => {
      // Only an OPEN shipment (SUBMITTED) surfaces as erroring — a normally-progressing,
      // shipped, or failed order never does, even if a stale count lingers on the row.
      expect(fulfillmentErrorAttention(status, 200)).toBeNull();
    },
  );

  it("does not flag a normally-progressing SUBMITTED order (no errors)", () => {
    expect(fulfillmentErrorAttention("SUBMITTED", 0)).toBeNull();
  });
});

describe("shopperShipmentView", () => {
  it.each(["PENDING", "CANCELLED", "REFUNDED"] as const)(
    "returns null for a %s order (the status badge already covers it)",
    (orderStatus) => {
      expect(shopperShipmentView(orderStatus, "SHIPPED")).toBeNull();
    },
  );

  it("reads a provider-confirmed shipment as Shipped", () => {
    expect(shopperShipmentView("FULFILLED", "SHIPPED")).toEqual({
      label: "Shipped",
      description: "Your order is on its way.",
    });
  });

  it("reads a manual FULFILLED override (no provider ship) as Shipped", () => {
    // Order.status FULFILLED but fulfillmentStatus never reached SHIPPED — the
    // admin fulfilled it by hand; still "on its way" to the shopper.
    expect(shopperShipmentView("FULFILLED", "NOT_SUBMITTED")?.label).toBe(
      "Shipped",
    );
  });

  it.each(["NOT_SUBMITTED", "SUBMITTING", "SUBMITTED", "FAILED"] as const)(
    "reads a PAID order in %s as Preparing (never exposing internal/FAILED state)",
    (fulfillmentStatus) => {
      expect(shopperShipmentView("PAID", fulfillmentStatus)?.label).toBe(
        "Preparing your order",
      );
    },
  );
});

describe("formatShippingAddressLines", () => {
  const base: ShippingAddressColumns = {
    shipName: "Ada Lovelace",
    shipLine1: "1 Infinite Loop",
    shipLine2: "Apt 5",
    shipCity: "Cupertino",
    shipState: "CA",
    shipPostalCode: "95014",
    shipCountry: "US",
  };

  it("renders a full address in postal order with an expanded country name", () => {
    expect(formatShippingAddressLines(base)).toEqual([
      "Ada Lovelace",
      "1 Infinite Loop",
      "Apt 5",
      "Cupertino, CA 95014",
      "United States",
    ]);
  });

  it("skips an absent line2 and folds a missing state out of the city line", () => {
    expect(
      formatShippingAddressLines({
        ...base,
        shipLine2: null,
        shipState: null,
      }),
    ).toEqual([
      "Ada Lovelace",
      "1 Infinite Loop",
      "Cupertino 95014",
      "United States",
    ]);
  });

  it("returns an empty array when the order carries no address", () => {
    expect(
      formatShippingAddressLines({
        shipName: null,
        shipLine1: null,
        shipLine2: null,
        shipCity: null,
        shipState: null,
        shipPostalCode: null,
        shipCountry: null,
      }),
    ).toEqual([]);
  });

  it("ignores whitespace-only fields", () => {
    expect(
      formatShippingAddressLines({
        ...base,
        shipLine2: "   ",
      }),
    ).not.toContain("   ");
  });
});

describe("trackingHref", () => {
  it.each(["https://track.example/abc", "http://track.example/abc"])(
    "returns an http(s) URL unchanged (%s)",
    (url) => {
      expect(trackingHref(url)).toBe(url);
    },
  );

  it("accepts a scheme regardless of case", () => {
    expect(trackingHref("HTTPS://track.example/abc")).toBe(
      "HTTPS://track.example/abc",
    );
  });

  it.each([
    null,
    undefined,
    "",
    "javascript:alert(1)",
    "data:text/html,x",
    "/relative/path",
    "ftp://host/file",
    "track.example/abc",
  ])("rejects a non-http(s) or empty value (%s) as null", (url) => {
    expect(trackingHref(url)).toBeNull();
  });
});

describe("formatCountry", () => {
  it("expands a known ISO alpha-2 code to a readable name", () => {
    expect(formatCountry("US")).toBe("United States");
  });

  it("is case-insensitive and trims", () => {
    expect(formatCountry("  us ")).toBe("United States");
  });

  it("returns an empty string for a blank code", () => {
    expect(formatCountry("")).toBe("");
    expect(formatCountry("   ")).toBe("");
  });

  it("falls back to the raw code for a structurally invalid one", () => {
    // A one-letter code isn't a valid region subtag — Intl throws, and the
    // helper returns the input rather than erroring the page.
    expect(formatCountry("U")).toBe("U");
  });
});
