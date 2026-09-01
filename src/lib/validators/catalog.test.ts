import { describe, it, expect } from "vitest";
import {
  productInputSchema,
  variantInputSchema,
  PRODUCT_STATUSES,
} from "@/lib/validators/catalog";

type VariantOverrides = Partial<Record<string, unknown>>;
type ProductOverrides = Partial<Record<string, unknown>>;

const validVariant = (o: VariantOverrides = {}) => ({
  sku: "TEE-S",
  name: "Small",
  priceCents: 1999,
  stock: 10,
  ...o,
});

const validProduct = (o: ProductOverrides = {}) => ({
  title: "Classic Tee",
  slug: "classic-tee",
  status: "ACTIVE",
  variants: [validVariant()],
  ...o,
});

describe("variantInputSchema", () => {
  it("accepts a well-formed variant", () => {
    expect(variantInputSchema.safeParse(validVariant()).success).toBe(true);
  });

  it("requires a non-empty sku and name", () => {
    expect(
      variantInputSchema.safeParse(validVariant({ sku: "" })).success,
    ).toBe(false);
    expect(
      variantInputSchema.safeParse(validVariant({ name: "   " })).success,
    ).toBe(false);
  });

  it("rejects negative, fractional, or over-ceiling priceCents", () => {
    expect(
      variantInputSchema.safeParse(validVariant({ priceCents: -1 })).success,
    ).toBe(false);
    expect(
      variantInputSchema.safeParse(validVariant({ priceCents: 19.99 })).success,
    ).toBe(false);
    expect(
      variantInputSchema.safeParse(validVariant({ priceCents: 100_000_001 }))
        .success,
    ).toBe(false);
    expect(
      variantInputSchema.safeParse(validVariant({ priceCents: 0 })).success,
    ).toBe(true);
  });

  it("rejects negative or over-ceiling stock", () => {
    expect(
      variantInputSchema.safeParse(validVariant({ stock: -1 })).success,
    ).toBe(false);
    expect(
      variantInputSchema.safeParse(validVariant({ stock: 1_000_001 })).success,
    ).toBe(false);
    expect(
      variantInputSchema.safeParse(validVariant({ stock: 0 })).success,
    ).toBe(true);
  });
});

describe("productInputSchema", () => {
  it("accepts a well-formed product", () => {
    expect(productInputSchema.safeParse(validProduct()).success).toBe(true);
  });

  it("requires a title within bounds", () => {
    expect(
      productInputSchema.safeParse(validProduct({ title: "" })).success,
    ).toBe(false);
    expect(
      productInputSchema.safeParse(validProduct({ title: "   " })).success,
    ).toBe(false);
    expect(
      productInputSchema.safeParse(validProduct({ title: "x".repeat(161) }))
        .success,
    ).toBe(false);
  });

  it("accepts valid slugs and rejects malformed ones", () => {
    for (const slug of ["classic-tee", "tee-123", "a"]) {
      expect(productInputSchema.safeParse(validProduct({ slug })).success).toBe(
        true,
      );
    }
    for (const slug of ["Bad Slug", "bad_slug", "-bad", "bad-", "UPPER", ""]) {
      expect(productInputSchema.safeParse(validProduct({ slug })).success).toBe(
        false,
      );
    }
  });

  it("only accepts the known statuses", () => {
    for (const status of PRODUCT_STATUSES) {
      expect(
        productInputSchema.safeParse(validProduct({ status })).success,
      ).toBe(true);
    }
    expect(
      productInputSchema.safeParse(validProduct({ status: "PUBLISHED" }))
        .success,
    ).toBe(false);
  });

  it("requires at least one variant", () => {
    expect(
      productInputSchema.safeParse(validProduct({ variants: [] })).success,
    ).toBe(false);
  });

  it("rejects duplicate SKUs case-insensitively", () => {
    const dupes = productInputSchema.safeParse(
      validProduct({
        variants: [
          validVariant({ sku: "TEE" }),
          validVariant({ sku: "tee", name: "Large" }),
        ],
      }),
    );
    expect(dupes.success).toBe(false);

    const distinct = productInputSchema.safeParse(
      validProduct({
        variants: [
          validVariant({ sku: "TEE-S" }),
          validVariant({ sku: "TEE-L", name: "Large" }),
        ],
      }),
    );
    expect(distinct.success).toBe(true);
  });

  it("treats description as optional but bounded", () => {
    expect(
      productInputSchema.safeParse(validProduct({ description: undefined }))
        .success,
    ).toBe(true);
    expect(
      productInputSchema.safeParse(validProduct({ description: "A soft tee." }))
        .success,
    ).toBe(true);
    expect(
      productInputSchema.safeParse(
        validProduct({ description: "x".repeat(2001) }),
      ).success,
    ).toBe(false);
  });
});
