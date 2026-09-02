import { describe, it, expect } from "vitest";
import {
  DEFAULT_THEME_HUE,
  TENANT_THEME_SELECTOR,
  TENANT_THEME_PORTAL_SELECTOR,
  resolveThemeHue,
  tenantThemeCss,
} from "@/lib/theme";

describe("resolveThemeHue", () => {
  it("passes through a valid integer hue in [0, 359]", () => {
    expect(resolveThemeHue(0)).toBe(0);
    expect(resolveThemeHue(162)).toBe(162);
    expect(resolveThemeHue(285)).toBe(285);
    expect(resolveThemeHue(359)).toBe(359);
  });

  it("falls back to the default for out-of-range values", () => {
    // 360 wraps to 0 in CSS but we reject it so the range is unambiguous; a
    // negative or absurd value can only come from a raw DB write.
    expect(resolveThemeHue(360)).toBe(DEFAULT_THEME_HUE);
    expect(resolveThemeHue(-1)).toBe(DEFAULT_THEME_HUE);
    expect(resolveThemeHue(99999)).toBe(DEFAULT_THEME_HUE);
  });

  it("falls back to the default for non-integer and NaN values", () => {
    expect(resolveThemeHue(162.5)).toBe(DEFAULT_THEME_HUE);
    expect(resolveThemeHue(Number.NaN)).toBe(DEFAULT_THEME_HUE);
    expect(resolveThemeHue(Number.POSITIVE_INFINITY)).toBe(DEFAULT_THEME_HUE);
  });
});

describe("tenantThemeCss", () => {
  it("scopes every rule to the theme wrapper and never leaks to :root", () => {
    const css = tenantThemeCss(285);
    expect(css).toContain(TENANT_THEME_SELECTOR);
    // The override must not target the document root, or it would bleed into
    // (admin)/(auth), which render as siblings under the same <html>.
    expect(css).not.toContain(":root");
    expect(css.toLowerCase()).not.toContain("html");
  });

  it("also themes portaled overlays via the marker, from the same recipe (#113)", () => {
    const css = tenantThemeCss(285);
    // The marker rides alongside the wrapper in BOTH the light rule and the dark
    // media rule, so a Select/dialog portaled to <body> inherits the store's hue.
    const scope = `${TENANT_THEME_SELECTOR},${TENANT_THEME_PORTAL_SELECTOR}`;
    expect(css).toContain(`${scope}{`);
    expect(css).toContain(`@media (prefers-color-scheme:dark){${scope}{`);
    // The marker shares the wrapper's accent values (one recipe, no drift) and the
    // rule stays element-scoped to the marker — never :root, so no (admin)/(auth)
    // bleed despite the document-wide selector.
    expect(css).toContain(`${scope}{--primary:oklch(0.5 0.12 285);`);
    expect(css).not.toContain(":root");
  });

  it("re-parametrizes the accent tokens by the given hue (light + dark)", () => {
    const css = tenantThemeCss(285);
    // Light recipe (L/C copied verbatim from globals.css :root).
    expect(css).toContain("--primary:oklch(0.5 0.12 285);");
    expect(css).toContain("--accent:oklch(0.96 0.02 285);");
    expect(css).toContain("--accent-foreground:oklch(0.35 0.09 285);");
    expect(css).toContain("--ring:oklch(0.55 0.13 285);");
    // Dark recipe, inside the same media query globals.css uses.
    expect(css).toContain("@media (prefers-color-scheme:dark)");
    expect(css).toContain("--primary:oklch(0.72 0.14 285);");
    expect(css).toContain("--ring:oklch(0.62 0.13 285);");
  });

  it("reproduces the base theme exactly for the default hue (visual no-op)", () => {
    const css = tenantThemeCss(DEFAULT_THEME_HUE);
    // Matches the emerald values authored in globals.css.
    expect(css).toContain("--primary:oklch(0.5 0.12 162);");
    expect(css).toContain("--primary:oklch(0.72 0.14 162);");
  });

  it("falls back to the default hue for an invalid stored value", () => {
    const css = tenantThemeCss(999);
    expect(css).toContain(`oklch(0.5 0.12 ${DEFAULT_THEME_HUE});`);
    expect(css).not.toContain("999");
  });

  it("emits only well-formed oklch() values — nothing can break out of the rule", () => {
    // Every interpolation is a bare integer in a complete oklch(...) call.
    const css = tenantThemeCss(42);
    const values = [...css.matchAll(/oklch\([^)]*\)/g)].map((m) => m[0]);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value).toMatch(/^oklch\(\d(?:\.\d+)? \d(?:\.\d+)? 42\)$/);
    }
    // No stray braces/semicolons could have leaked from the hue.
    expect(css).not.toContain(";;");
  });
});
