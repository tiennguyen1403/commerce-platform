import { describe, it, expect } from "vitest";
import {
  MAX_CART_QTY,
  MAX_CART_LINES,
  cartLineSchema,
  cartCookieSchema,
  addToCartInputSchema,
  updateQtyInputSchema,
  removeInputSchema,
  normalizeCart,
  setLineQty,
  removeLine,
  cartItemCount,
  type CartLine,
} from "@/lib/cart";

const line = (variantId: string, qty: number): CartLine => ({ variantId, qty });

describe("normalizeCart", () => {
  it("merges duplicate variantIds by summing qty, first-seen order preserved", () => {
    const out = normalizeCart([line("b", 1), line("a", 1), line("b", 2)]);
    expect(out).toEqual([line("b", 3), line("a", 1)]);
  });

  it("drops non-positive and non-integer qty", () => {
    const out = normalizeCart([
      line("a", 0),
      line("b", -3),
      line("c", 1.5),
      line("d", 2),
    ]);
    expect(out).toEqual([line("d", 2)]);
  });

  it("clamps each merged qty to MAX_CART_QTY", () => {
    const out = normalizeCart([line("a", 60), line("a", 60)]);
    expect(out).toEqual([line("a", MAX_CART_QTY)]);
  });

  it("caps distinct lines at MAX_CART_LINES, keeping the first-seen ones", () => {
    const many = Array.from({ length: MAX_CART_LINES + 5 }, (_, i) =>
      line(`v${i}`, 1),
    );
    const out = normalizeCart(many);
    expect(out).toHaveLength(MAX_CART_LINES);
    expect(out[0]).toEqual(line("v0", 1));
    expect(out.at(-1)).toEqual(line(`v${MAX_CART_LINES - 1}`, 1));
  });

  it("returns an empty array for empty input", () => {
    expect(normalizeCart([])).toEqual([]);
  });
});

describe("setLineQty", () => {
  it("inserts a new line when the variant is absent", () => {
    expect(setLineQty([], "a", 3)).toEqual([line("a", 3)]);
  });

  it("replaces qty in place when the variant exists", () => {
    expect(setLineQty([line("a", 1), line("b", 2)], "a", 5)).toEqual([
      line("a", 5),
      line("b", 2),
    ]);
  });

  it("clamps qty to MAX_CART_QTY", () => {
    expect(setLineQty([], "a", 500)).toEqual([line("a", MAX_CART_QTY)]);
  });

  it("removes the line when qty drops below 1", () => {
    expect(setLineQty([line("a", 1), line("b", 2)], "a", 0)).toEqual([
      line("b", 2),
    ]);
    expect(setLineQty([line("a", 1)], "a", -5)).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const original = [line("a", 1)];
    setLineQty(original, "a", 9);
    setLineQty(original, "b", 2);
    expect(original).toEqual([line("a", 1)]);
  });
});

describe("removeLine", () => {
  it("removes the matching line", () => {
    expect(removeLine([line("a", 1), line("b", 2)], "a")).toEqual([
      line("b", 2),
    ]);
  });

  it("is a no-op when the variant is absent", () => {
    expect(removeLine([line("a", 1)], "z")).toEqual([line("a", 1)]);
  });

  it("does not mutate the input array", () => {
    const original = [line("a", 1), line("b", 2)];
    removeLine(original, "a");
    expect(original).toEqual([line("a", 1), line("b", 2)]);
  });
});

describe("cartItemCount", () => {
  it("sums the qty across all lines", () => {
    expect(cartItemCount([line("a", 2), line("b", 3)])).toBe(5);
  });

  it("is 0 for an empty cart", () => {
    expect(cartItemCount([])).toBe(0);
  });
});

describe("cart schemas", () => {
  it("cartLineSchema accepts a valid line", () => {
    expect(cartLineSchema.safeParse({ variantId: "v1", qty: 1 }).success).toBe(
      true,
    );
  });

  it("cartLineSchema rejects qty out of [1, MAX_CART_QTY] and non-integers", () => {
    expect(cartLineSchema.safeParse({ variantId: "v1", qty: 0 }).success).toBe(
      false,
    );
    expect(
      cartLineSchema.safeParse({ variantId: "v1", qty: MAX_CART_QTY + 1 })
        .success,
    ).toBe(false);
    expect(
      cartLineSchema.safeParse({ variantId: "v1", qty: 1.5 }).success,
    ).toBe(false);
  });

  it("cartLineSchema rejects a blank or oversized variantId", () => {
    expect(cartLineSchema.safeParse({ variantId: "   ", qty: 1 }).success).toBe(
      false,
    );
    expect(
      cartLineSchema.safeParse({ variantId: "x".repeat(65), qty: 1 }).success,
    ).toBe(false);
  });

  it("addToCartInputSchema defaults qty to 1", () => {
    const parsed = addToCartInputSchema.parse({ variantId: "v1" });
    expect(parsed.qty).toBe(1);
  });

  it("updateQtyInputSchema requires an explicit qty", () => {
    expect(updateQtyInputSchema.safeParse({ variantId: "v1" }).success).toBe(
      false,
    );
  });

  it("removeInputSchema requires a variantId", () => {
    expect(removeInputSchema.safeParse({ variantId: "v1" }).success).toBe(true);
    expect(removeInputSchema.safeParse({}).success).toBe(false);
  });

  it("cartCookieSchema rejects more than MAX_CART_LINES entries", () => {
    const tooMany = Array.from({ length: MAX_CART_LINES + 1 }, (_, i) =>
      line(`v${i}`, 1),
    );
    expect(cartCookieSchema.safeParse(tooMany).success).toBe(false);
    expect(
      cartCookieSchema.safeParse([{ variantId: "v1", qty: 1 }]).success,
    ).toBe(true);
  });
});
