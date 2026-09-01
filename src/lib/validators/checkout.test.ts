import { describe, it, expect } from "vitest";
import { checkoutInputSchema } from "@/lib/validators/checkout";

describe("checkoutInputSchema", () => {
  it("accepts a valid email", () => {
    expect(
      checkoutInputSchema.safeParse({ email: "shopper@example.com" }).success,
    ).toBe(true);
  });

  it("rejects malformed emails", () => {
    for (const email of ["notanemail", "a@", "@b.com", "", "a b@c.com"]) {
      expect(checkoutInputSchema.safeParse({ email }).success).toBe(false);
    }
  });

  it("rejects an address longer than 254 characters", () => {
    const tooLong = `${"a".repeat(250)}@example.com`;
    expect(tooLong.length).toBeGreaterThan(254);
    expect(checkoutInputSchema.safeParse({ email: tooLong }).success).toBe(
      false,
    );
  });

  it("requires the email field to be present", () => {
    expect(checkoutInputSchema.safeParse({}).success).toBe(false);
  });
});
