import { describe, it, expect } from "vitest";
import { formatMoney, slugify, cn, formatDate } from "@/lib/utils";

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

describe("formatDate", () => {
  const d = new Date("2026-09-01T12:00:00.000Z");

  it("formats a medium date (no time) by default", () => {
    const s = formatDate(d);
    expect(s).toMatch(/2026/);
    expect(s).not.toMatch(/:/); // no clock time when withTime is false
  });

  it("adds a time + timezone label when withTime is true", () => {
    // Regression guard for the ECMA-402 rule that `timeZoneName` may NOT be
    // combined with dateStyle/timeStyle (it throws "Invalid option" at runtime,
    // which TS does not catch). Must not throw, and must include a HH:MM time.
    expect(() => formatDate(d, true)).not.toThrow();
    const s = formatDate(d, true);
    expect(s).toMatch(/2026/);
    expect(s).toMatch(/:\d{2}/);
  });

  it("accepts an ISO string", () => {
    expect(formatDate("2026-09-01T12:00:00.000Z")).toMatch(/2026/);
  });
});
