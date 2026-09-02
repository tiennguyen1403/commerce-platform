import { describe, it, expect } from "vitest";
import { parseOklch, oklchToSrgb } from "@/lib/color";

describe("parseOklch", () => {
  it("parses the L C H form", () => {
    expect(parseOklch("oklch(0.5 0.12 162)")).toEqual({
      l: 0.5,
      c: 0.12,
      h: 162,
      alpha: 1,
    });
  });

  it("parses a slash alpha, both percent and unit-interval forms", () => {
    expect(parseOklch("oklch(1 0 0 / 10%)")?.alpha).toBe(0.1);
    expect(parseOklch("oklch(1 0 0 / 0.1)")?.alpha).toBe(0.1);
  });

  it("tolerates the leading/trailing whitespace getPropertyValue returns", () => {
    // `getComputedStyle(...).getPropertyValue('--x')` commonly yields a leading
    // space; the token must still parse.
    expect(parseOklch("  oklch(0.5 0.12 162)  ")).toEqual({
      l: 0.5,
      c: 0.12,
      h: 162,
      alpha: 1,
    });
  });

  it("clamps alpha into 0–1", () => {
    expect(parseOklch("oklch(1 0 0 / 150%)")?.alpha).toBe(1);
  });

  it("returns null for non-oklch tokens", () => {
    // A radius token, an empty read, another color space, and a truncated value
    // must all be rejected so the caller can skip them.
    expect(parseOklch("0.625rem")).toBeNull();
    expect(parseOklch("")).toBeNull();
    expect(parseOklch("rgb(0, 0, 0)")).toBeNull();
    expect(parseOklch("oklch(0.5 0.12)")).toBeNull();
  });
});

describe("oklchToSrgb", () => {
  // Reference values: our tokens are Tailwind's OKLCH neutral ramp + a custom
  // emerald hue-162 accent, so these double as a check against Tailwind's own
  // palette (e.g. neutral-500 #737373, neutral-200 #e5e5e5, red-600 #e7000b).
  it.each([
    ["oklch(1 0 0)", "#ffffff"], // --background (light)
    ["oklch(0 0 0)", "#000000"],
    ["oklch(0.145 0 0)", "#0a0a0a"], // --foreground (light) / --background (dark)
    ["oklch(0.985 0 0)", "#fafafa"], // --foreground (dark)
    ["oklch(0.556 0 0)", "#737373"], // --muted-foreground (light)
    ["oklch(0.922 0 0)", "#e5e5e5"], // --border / --input (light)
    ["oklch(0.5 0.12 162)", "#00774d"], // --primary (light) — emerald
    ["oklch(0.72 0.14 162)", "#39bf89"], // --primary (dark) — emerald
    ["oklch(0.577 0.245 27.325)", "#e7000b"], // --destructive (light)
    ["oklch(0.704 0.191 22.216)", "#ff6467"], // --destructive (dark)
  ])("resolves %s → %s", (input, expected) => {
    expect(oklchToSrgb(input)).toBe(expected);
  });

  it("emits rgba() for tokens that carry alpha (dark-mode borders)", () => {
    expect(oklchToSrgb("oklch(1 0 0 / 10%)")).toBe("rgba(255, 255, 255, 0.1)");
    expect(oklchToSrgb("oklch(1 0 0 / 15%)")).toBe("rgba(255, 255, 255, 0.15)");
  });

  it("returns null for a value it can't resolve, so callers can skip it", () => {
    expect(oklchToSrgb("0.625rem")).toBeNull();
    expect(oklchToSrgb("")).toBeNull();
  });
});
