import { describe, it, expect } from "vitest";
import {
  checkoutInputSchema,
  shippingAddressSchema,
  SHIPPING_COUNTRIES,
} from "@/lib/validators/checkout";

/** A valid US shipping address — the baseline each case tweaks one field of. */
const validAddress = {
  name: "Ada Lovelace",
  line1: "1 Analytical Ave",
  line2: "Apt 2",
  city: "San Francisco",
  state: "CA",
  postalCode: "94103",
  country: "US",
} as const;

/** `validAddress` with one field omitted — for the "field absent" cases, without
 *  the destructure-to-omit pattern that trips no-unused-vars. */
function withoutField(key: keyof typeof validAddress) {
  const clone: Record<string, unknown> = { ...validAddress };
  delete clone[key];
  return clone;
}

describe("shippingAddressSchema", () => {
  it("accepts a valid US address", () => {
    expect(shippingAddressSchema.safeParse(validAddress).success).toBe(true);
  });

  it("accepts an omitted line2 (optional) and a ZIP+4 postal code", () => {
    expect(shippingAddressSchema.safeParse(withoutField("line2")).success).toBe(
      true,
    );
    expect(
      shippingAddressSchema.safeParse({
        ...validAddress,
        postalCode: "94103-1234",
      }).success,
    ).toBe(true);
  });

  it("trims surrounding whitespace on string fields", () => {
    const parsed = shippingAddressSchema.safeParse({
      ...validAddress,
      name: "  Ada Lovelace  ",
      line1: "  1 Analytical Ave  ",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name).toBe("Ada Lovelace");
      expect(parsed.data.line1).toBe("1 Analytical Ave");
    }
  });

  it("rejects a country outside the allowlist (including wrong case)", () => {
    for (const country of ["CA", "GB", "us", "USA", ""]) {
      expect(
        shippingAddressSchema.safeParse({ ...validAddress, country }).success,
      ).toBe(false);
    }
  });

  it("ships US-only for now", () => {
    // Guards the "US-only to start" scope: widening is a deliberate change, not
    // an accident. Update this alongside SHIPPING_COUNTRIES when a country lands.
    expect([...SHIPPING_COUNTRIES]).toEqual(["US"]);
  });

  it("rejects an empty required field", () => {
    for (const field of ["name", "line1", "city", "postalCode"] as const) {
      const parsed = shippingAddressSchema.safeParse({
        ...validAddress,
        [field]: "   ",
      });
      expect(parsed.success, `${field} should be required`).toBe(false);
    }
  });

  it("requires a state for a US address", () => {
    expect(shippingAddressSchema.safeParse(withoutField("state")).success).toBe(
      false,
    );
    const parsed = shippingAddressSchema.safeParse({
      ...validAddress,
      state: "  ",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      // The message lands on the state field so the form can target it.
      expect(parsed.error.issues.some((i) => i.path.at(-1) === "state")).toBe(
        true,
      );
    }
  });

  it("rejects a malformed US ZIP code", () => {
    for (const postalCode of ["1234", "123456", "abcde", "9410a", "94103-12"]) {
      expect(
        shippingAddressSchema.safeParse({ ...validAddress, postalCode })
          .success,
      ).toBe(false);
    }
  });

  it("rejects an over-long field", () => {
    expect(
      shippingAddressSchema.safeParse({
        ...validAddress,
        name: "a".repeat(121),
      }).success,
    ).toBe(false);
  });
});

describe("checkoutInputSchema", () => {
  it("accepts a valid email + shipping address", () => {
    expect(
      checkoutInputSchema.safeParse({
        email: "shopper@example.com",
        shippingAddress: validAddress,
      }).success,
    ).toBe(true);
  });

  it("rejects malformed emails", () => {
    for (const email of ["notanemail", "a@", "@b.com", "", "a b@c.com"]) {
      expect(
        checkoutInputSchema.safeParse({ email, shippingAddress: validAddress })
          .success,
      ).toBe(false);
    }
  });

  it("rejects an address longer than 254 characters", () => {
    const tooLong = `${"a".repeat(250)}@example.com`;
    expect(tooLong.length).toBeGreaterThan(254);
    expect(
      checkoutInputSchema.safeParse({
        email: tooLong,
        shippingAddress: validAddress,
      }).success,
    ).toBe(false);
  });

  it("requires both the email and the shipping address", () => {
    expect(checkoutInputSchema.safeParse({}).success).toBe(false);
    expect(
      checkoutInputSchema.safeParse({ email: "shopper@example.com" }).success,
    ).toBe(false);
    expect(
      checkoutInputSchema.safeParse({ shippingAddress: validAddress }).success,
    ).toBe(false);
  });

  it("scopes an address issue under the shippingAddress path", () => {
    const parsed = checkoutInputSchema.safeParse({
      email: "shopper@example.com",
      shippingAddress: { ...validAddress, city: "" },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some(
          (i) => i.path[0] === "shippingAddress" && i.path[1] === "city",
        ),
      ).toBe(true);
    }
  });
});
