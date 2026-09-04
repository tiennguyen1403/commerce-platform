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

  it("treats providerVariantId as optional, trimmed, and length-bounded", () => {
    // Absent → valid: an unmapped variant is a defined, admin-visible state.
    expect(variantInputSchema.safeParse(validVariant()).success).toBe(true);
    // Blank must not error either (the form blanks an unmapped field).
    expect(
      variantInputSchema.safeParse(validVariant({ providerVariantId: "" }))
        .success,
    ).toBe(true);
    // A value is trimmed on the way through.
    const parsed = variantInputSchema.parse(
      validVariant({ providerVariantId: "  4012  " }),
    );
    expect(parsed.providerVariantId).toBe("4012");
    // Over the 64-char ceiling is rejected.
    expect(
      variantInputSchema.safeParse(
        validVariant({ providerVariantId: "x".repeat(65) }),
      ).success,
    ).toBe(false);
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

  it("re-parses its own parsed output (the Server Action double-parse contract)", () => {
    // The client form parses raw input, then the Server Action re-parses that
    // already-parsed payload. The schema must accept its own output — including
    // a mapped providerVariantId — or the second parse would reject a value the
    // first produced. A `.transform(... ?? null)` would break exactly this.
    const once = productInputSchema.parse(
      validProduct({ variants: [validVariant({ providerVariantId: "4012" })] }),
    );
    expect(productInputSchema.safeParse(once).success).toBe(true);
    expect(once.variants[0].providerVariantId).toBe("4012");
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
