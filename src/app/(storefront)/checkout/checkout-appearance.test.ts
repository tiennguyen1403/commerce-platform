import { describe, it, expect } from "vitest";

import { buildCheckoutAppearance } from "./checkout-appearance";

/** A fake `getComputedStyle` result backed by a plain token map. */
function tokenSource(map: Record<string, string>) {
  return { getPropertyValue: (name: string) => map[name] ?? "" };
}

// The live values from `src/app/globals.css` — light `:root` and the
// `@media (prefers-color-scheme: dark)` block. Kept here so the test fails loudly
// if the mapping (which token feeds which Stripe variable) ever regresses.
const LIGHT_TOKENS = {
  "--background": "oklch(1 0 0)",
  "--foreground": "oklch(0.145 0 0)",
  "--primary": "oklch(0.5 0.12 162)",
  "--muted-foreground": "oklch(0.556 0 0)",
  "--input": "oklch(0.922 0 0)",
  "--destructive": "oklch(0.577 0.245 27.325)",
  "--radius": "0.625rem",
};

const DARK_TOKENS = {
  "--background": "oklch(0.145 0 0)",
  "--foreground": "oklch(0.985 0 0)",
  "--primary": "oklch(0.72 0.14 162)",
  "--muted-foreground": "oklch(0.708 0 0)",
  "--input": "oklch(1 0 0 / 15%)",
  "--destructive": "oklch(0.704 0.191 22.216)",
  "--radius": "0.625rem",
};

describe("buildCheckoutAppearance", () => {
  it("maps the light tokens onto Stripe's 'stripe' base theme", () => {
    const appearance = buildCheckoutAppearance(
      false,
      tokenSource(LIGHT_TOKENS),
    );
    expect(appearance).toEqual({
      theme: "stripe",
      variables: {
        colorBackground: "#ffffff",
        colorText: "#0a0a0a",
        colorTextSecondary: "#737373",
        colorTextPlaceholder: "#737373",
        colorPrimary: "#00774d", // emerald, not Stripe's default blue
        colorDanger: "#e7000b",
        inputColorBorder: "#e5e5e5",
        borderRadius: "0.625rem",
      },
    });
  });

  it("maps the dark tokens onto the 'night' base theme", () => {
    const appearance = buildCheckoutAppearance(true, tokenSource(DARK_TOKENS));
    expect(appearance).toEqual({
      theme: "night",
      variables: {
        colorBackground: "#0a0a0a",
        colorText: "#fafafa",
        colorTextSecondary: "#a1a1a1",
        colorTextPlaceholder: "#a1a1a1",
        colorPrimary: "#39bf89", // brighter emerald for dark
        colorDanger: "#ff6467",
        // The translucent dark border keeps its alpha (rgba, not a flattened hex).
        inputColorBorder: "rgba(255, 255, 255, 0.15)",
        borderRadius: "0.625rem",
      },
    });
  });

  it("trims the whitespace getPropertyValue prepends", () => {
    const appearance = buildCheckoutAppearance(
      false,
      tokenSource({ "--primary": "  oklch(0.5 0.12 162)  " }),
    );
    expect(appearance.variables?.colorPrimary).toBe("#00774d");
  });

  it("omits any token it can't read, falling back to the base theme", () => {
    // Every read is empty → no variables set, just the base theme.
    const appearance = buildCheckoutAppearance(false, tokenSource({}));
    expect(appearance).toEqual({ theme: "stripe", variables: {} });
  });

  it("returns only the base theme with no DOM to read (SSR)", () => {
    // The unit project runs in node: `document` is undefined, so with no injected
    // source the builder must not touch the DOM and returns just the theme.
    expect(buildCheckoutAppearance(true)).toEqual({ theme: "night" });
  });
});
