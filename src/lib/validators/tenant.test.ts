import { describe, it, expect } from "vitest";
import { createStoreSchema } from "@/lib/validators/tenant";

/**
 * Pure zod tests for the store-onboarding input shape — no mocks, no server
 * import. This schema is shared by the client `/new` form (UX validation) and
 * the Server Action (authoritative validation), so it must stay safe to
 * import from a client component; these tests exercise it exactly as either
 * caller would, via `safeParse`.
 */

type Overrides = Partial<Record<string, unknown>>;

const validInput = (o: Overrides = {}) => ({
  name: "Ada's Shop",
  slug: "ada-shop",
  ...o,
});

describe("createStoreSchema", () => {
  it("accepts a well-formed store", () => {
    expect(createStoreSchema.safeParse(validInput()).success).toBe(true);
  });

  it("normalizes the slug — trims and lowercases before validating", () => {
    const result = createStoreSchema.safeParse(
      validInput({ slug: "  Ada-Shop  " }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.slug).toBe("ada-shop");
  });

  it("trims the name", () => {
    const result = createStoreSchema.safeParse(
      validInput({ name: "  Ada's Shop  " }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.name).toBe("Ada's Shop");
  });

  it("rejects a slug that is too short (under 3 chars)", () => {
    expect(
      createStoreSchema.safeParse(validInput({ slug: "ab" })).success,
    ).toBe(false);
  });

  it("rejects a slug that is too long (over 63 chars)", () => {
    expect(
      createStoreSchema.safeParse(validInput({ slug: "a".repeat(64) })).success,
    ).toBe(false);
  });

  it("rejects malformed slug shapes", () => {
    for (const slug of ["a b", "a_b", "-lead", "trail-"]) {
      expect(createStoreSchema.safeParse(validInput({ slug })).success).toBe(
        false,
      );
    }
  });

  it("rejects the reserved slug 'admin'", () => {
    expect(
      createStoreSchema.safeParse(validInput({ slug: "admin" })).success,
    ).toBe(false);
  });

  it("rejects a reserved slug given in a non-lowercase form (checked post-normalization)", () => {
    expect(
      createStoreSchema.safeParse(validInput({ slug: "ADMIN" })).success,
    ).toBe(false);
  });

  it("rejects an empty or whitespace-only name", () => {
    expect(createStoreSchema.safeParse(validInput({ name: "" })).success).toBe(
      false,
    );
    expect(
      createStoreSchema.safeParse(validInput({ name: "   " })).success,
    ).toBe(false);
  });

  it("rejects a name over the length ceiling (over 160 chars)", () => {
    expect(
      createStoreSchema.safeParse(validInput({ name: "x".repeat(161) }))
        .success,
    ).toBe(false);
  });
});
