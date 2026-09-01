import { describe, it, expect } from "vitest";
import { formatMoney, slugify, cn } from "@/lib/utils";

describe("formatMoney", () => {
  it("formats integer cents as USD by default", () => {
    expect(formatMoney(1000)).toBe("$10.00");
    expect(formatMoney(999)).toBe("$9.99");
    expect(formatMoney(0)).toBe("$0.00");
  });

  it("groups thousands and keeps two fraction digits", () => {
    expect(formatMoney(123456)).toBe("$1,234.56");
  });

  it("renders negative amounts with a leading sign", () => {
    expect(formatMoney(-500)).toBe("-$5.00");
  });

  it("honors the currency argument, case-insensitively", () => {
    expect(formatMoney(1000, "eur")).toBe("€10.00");
    expect(formatMoney(1000, "gbp")).toBe("£10.00");
    expect(formatMoney(1000, "USD")).toBe("$10.00");
  });
});

describe("slugify", () => {
  it("lowercases and hyphenates whitespace", () => {
    expect(slugify("Classic Tee")).toBe("classic-tee");
  });

  it("trims and collapses runs of separators", () => {
    expect(slugify("  Hello   World  ")).toBe("hello-world");
    expect(slugify("Foo & Bar!")).toBe("foo-bar");
    expect(slugify("A.B.C")).toBe("a-b-c");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugify("--Hello--")).toBe("hello");
  });

  it("decomposes accents to their base letters", () => {
    expect(slugify("Café")).toBe("cafe");
  });

  it("keeps digits", () => {
    expect(slugify("Product 123")).toBe("product-123");
    expect(slugify("Summer Sale 2026")).toBe("summer-sale-2026");
  });

  it("passes an already-clean slug through unchanged", () => {
    expect(slugify("classic-tee")).toBe("classic-tee");
  });

  it("returns an empty string when nothing survives", () => {
    expect(slugify("!!!")).toBe("");
    expect(slugify("   ")).toBe("");
    expect(slugify("")).toBe("");
  });
});

describe("cn", () => {
  it("merges class names and de-duplicates conflicting Tailwind utilities", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("text-sm", false && "hidden", "font-bold")).toBe(
      "text-sm font-bold",
    );
  });
});
