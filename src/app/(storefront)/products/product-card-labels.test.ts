import { describe, expect, it } from "vitest";
import { LOW_STOCK_THRESHOLD } from "@/config/constants";
import {
  inEntryOrder,
  lowStockLabel,
  priceLabel,
  variantsLabel,
} from "./product-card-labels";

/**
 * `product-card-labels` unit tests — pure functions, nothing to render.
 *
 * Each fixture below includes only the fields the function under test's own
 * `Pick<CardVariant, …>` parameter reads (per the module's doc comment), so a
 * failing assertion points straight at the field in play rather than an
 * unrelated one carried along for realism.
 */

describe("inEntryOrder", () => {
  it("sorts variants by createdAt ascending", () => {
    const oldest = {
      id: "v-old",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const middle = {
      id: "v-mid",
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    };
    const newest = {
      id: "v-new",
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
    };

    expect(inEntryOrder([newest, oldest, middle])).toEqual([
      oldest,
      middle,
      newest,
    ]);
  });

  it("breaks a createdAt tie by id ascending — the real seed case where one write shares a millisecond", () => {
    // Same instant for all three (the seed's hoodie): only the cuid tail
    // orders them. '8' < '9' < 'a' as plain characters, so id order alone
    // must yield Small, Medium, Large regardless of input order.
    const sameInstant = new Date("2026-01-01T00:00:00.000Z");
    const medium = {
      id: "ckvariant0009",
      name: "Medium",
      createdAt: sameInstant,
    };
    const large = {
      id: "ckvariant000a",
      name: "Large",
      createdAt: sameInstant,
    };
    const small = {
      id: "ckvariant0008",
      name: "Small",
      createdAt: sameInstant,
    };

    expect(inEntryOrder([medium, large, small]).map((v) => v.name)).toEqual([
      "Small",
      "Medium",
      "Large",
    ]);
  });

  it("returns a new array and never mutates a frozen input", () => {
    const first = {
      id: "b",
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    };
    const second = {
      id: "a",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    // Frozen so an in-place `.sort()` regression would throw (strict mode)
    // instead of silently passing.
    const input = Object.freeze([first, second]);

    const result = inEntryOrder(input);

    expect(result).not.toBe(input);
    expect(result).toEqual([second, first]);
    expect(input).toEqual([first, second]);
  });
});

describe("priceLabel", () => {
  it("returns an em dash for no variants", () => {
    expect(priceLabel([], "usd")).toBe("—");
  });

  it("returns the flat price when every variant matches", () => {
    expect(
      priceLabel([{ priceCents: 1999 }, { priceCents: 1999 }], "usd"),
    ).toBe("$19.99");
  });

  it('prefixes "From" with the cheapest price when variants differ', () => {
    expect(
      priceLabel([{ priceCents: 2499 }, { priceCents: 1999 }], "usd"),
    ).toBe("From $19.99");
  });

  it("passes the currency argument through to formatMoney", () => {
    expect(priceLabel([{ priceCents: 1999 }], "eur")).toBe("€19.99");
  });
});

describe("variantsLabel", () => {
  it("returns null for no variants", () => {
    expect(variantsLabel([])).toBeNull();
  });

  it("returns the variant's own name when there is exactly one", () => {
    expect(variantsLabel([{ name: "12 oz" }])).toBe("12 oz");
    expect(variantsLabel([{ name: "One size" }])).toBe("One size");
  });

  it("lists the count and the name range, in the given order, for more than one", () => {
    expect(
      variantsLabel([{ name: "Small" }, { name: "Medium" }, { name: "Large" }]),
    ).toBe("3 sizes · Small–Large");
  });

  it("drops the range when the first and last names are equal", () => {
    expect(variantsLabel([{ name: "One size" }, { name: "One size" }])).toBe(
      "2 sizes",
    );
  });
});

describe("lowStockLabel", () => {
  it("returns null for no variants", () => {
    expect(lowStockLabel([])).toBeNull();
  });

  it("returns null when every variant is sold out, including reserved at or above stock", () => {
    expect(
      lowStockLabel([
        { stock: 4, reserved: 4 }, // exactly sold out
        { stock: 3, reserved: 5 }, // reserved exceeds stock — floored at 0, not negative
      ]),
    ).toBeNull();
  });

  it("reports the exact count at the low end", () => {
    expect(lowStockLabel([{ stock: 4, reserved: 0 }])).toBe("Only 4 left");
  });

  it(`reports "Only N left" exactly at the threshold (${LOW_STOCK_THRESHOLD})`, () => {
    expect(lowStockLabel([{ stock: LOW_STOCK_THRESHOLD, reserved: 0 }])).toBe(
      `Only ${LOW_STOCK_THRESHOLD} left`,
    );
  });

  it("returns null one unit above the threshold", () => {
    expect(
      lowStockLabel([{ stock: LOW_STOCK_THRESHOLD + 1, reserved: 0 }]),
    ).toBeNull();
  });

  it("sums available units across every variant before comparing to the threshold", () => {
    // 0 + 11 = 11, above the threshold → null, even though one variant alone
    // would already read as sold out.
    expect(
      lowStockLabel([
        { stock: 3, reserved: 3 },
        { stock: 12, reserved: 1 },
      ]),
    ).toBeNull();

    // 2 + 2 = 4, at/under the threshold once summed.
    expect(
      lowStockLabel([
        { stock: 2, reserved: 0 },
        { stock: 3, reserved: 1 },
      ]),
    ).toBe("Only 4 left");
  });
});
