import { describe, it, expect } from "vitest";
import { updateNameSchema, updateThemeSchema } from "@/lib/validators/settings";

/**
 * Unit tests for the branding-settings input schemas. These are the
 * authoritative server-side boundary the Server Actions parse against, so the
 * cases that matter are the ones a tampered payload (or a stored legacy value)
 * could carry: the name's trim/length rules, and the hue's integer-degree range
 * — "invalid hue rejected server-side" is exactly this schema saying no.
 */

describe("updateNameSchema", () => {
  it("accepts and trims a normal name", () => {
    const result = updateNameSchema.safeParse({ name: "  Aurora Living  " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe("Aurora Living");
  });

  it("rejects an empty or whitespace-only name", () => {
    expect(updateNameSchema.safeParse({ name: "" }).success).toBe(false);
    expect(updateNameSchema.safeParse({ name: "   " }).success).toBe(false);
  });

  it("accepts a name at the 160-character ceiling but rejects one over it", () => {
    expect(updateNameSchema.safeParse({ name: "x".repeat(160) }).success).toBe(
      true,
    );
    expect(updateNameSchema.safeParse({ name: "x".repeat(161) }).success).toBe(
      false,
    );
  });
});

describe("updateThemeSchema", () => {
  it("accepts an integer hue across the full 0–359 wheel", () => {
    for (const themeHue of [0, 162, 359]) {
      expect(updateThemeSchema.safeParse({ themeHue }).success).toBe(true);
    }
  });

  it("rejects a hue outside 0–359", () => {
    expect(updateThemeSchema.safeParse({ themeHue: -1 }).success).toBe(false);
    expect(updateThemeSchema.safeParse({ themeHue: 360 }).success).toBe(false);
  });

  it("rejects a non-integer or non-number hue", () => {
    expect(updateThemeSchema.safeParse({ themeHue: 1.5 }).success).toBe(false);
    expect(updateThemeSchema.safeParse({ themeHue: Number.NaN }).success).toBe(
      false,
    );
    expect(updateThemeSchema.safeParse({ themeHue: "162" }).success).toBe(
      false,
    );
  });
});
