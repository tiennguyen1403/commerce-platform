import type { Appearance } from "@stripe/stripe-js";

import { oklchToSrgb } from "@/lib/color";
import { TENANT_THEME_SELECTOR } from "@/lib/theme";

/**
 * Build the Stripe Payment Element `appearance` from the app's live design
 * tokens, so the embedded card widget matches the active store's accent and
 * radius instead of Stripe's default blue-on-white / blue-on-night presets.
 *
 * Why read the tokens at runtime rather than hardcode a hex palette: the Stripe
 * iframe can't see our `:root` custom properties, so the values must be
 * materialized to plain sRGB *somewhere*. Reading them from `getComputedStyle`
 * keeps `globals.css` the single source of truth (a design-token change flows
 * through automatically, with no hex map to drift), and — because our dark mode
 * is `prefers-color-scheme`-driven — the computed values already reflect whichever
 * scheme is active, including a live OS switch. `oklchToSrgb` does the space
 * conversion deterministically, so we never depend on how a browser happens to
 * serialize a resolved color.
 *
 * We read from the per-tenant theme wrapper (`[data-tenant-theme]`, #98), not the
 * document root, so `--primary` resolves to the *active store's* accent — the
 * widget matches whichever hue the storefront is showing. The neutral tokens
 * (background, text, borders) aren't overridden there, so they inherit from
 * `:root` and read identically either way.
 *
 * Everything degrades gracefully: a token that can't be read/parsed is simply
 * omitted, leaving Stripe's base `theme` value for that property — so the worst
 * case is the pre-existing "night"/"stripe" preset, never a broken widget.
 */

/** The slice of `CSSStyleDeclaration` we need — injectable so this is unit-testable. */
type TokenSource = Pick<CSSStyleDeclaration, "getPropertyValue">;

/**
 * Live design tokens for the active storefront: the per-tenant theme wrapper when
 * present (so `--primary` is the store's accent), else the document root. `null`
 * during SSR (no `document`), where the caller falls back to the base Stripe theme.
 */
function defaultTokenSource(): TokenSource | null {
  if (typeof document === "undefined") return null;
  const themed = document.querySelector(TENANT_THEME_SELECTOR);
  return getComputedStyle(themed ?? document.documentElement);
}

export function buildCheckoutAppearance(
  prefersDark: boolean,
  source?: TokenSource,
): Appearance {
  // Keep the closest prebuilt theme as the base (Stripe's recommended workflow:
  // pick a theme, then override with variables); our overrides sit on top.
  const theme: Appearance["theme"] = prefersDark ? "night" : "stripe";

  const styles = source ?? defaultTokenSource();
  if (!styles) return { theme };

  const raw = (name: string) => styles.getPropertyValue(name).trim();
  const color = (name: string) => oklchToSrgb(raw(name)) ?? undefined;

  const variables: NonNullable<Appearance["variables"]> = {};

  // Surface + text: make the widget sit on our background with our text colors.
  const background = color("--background");
  if (background) variables.colorBackground = background;
  const text = color("--foreground");
  if (text) variables.colorText = text;
  const textSecondary = color("--muted-foreground");
  if (textSecondary) {
    variables.colorTextSecondary = textSecondary;
    variables.colorTextPlaceholder = textSecondary;
  }

  // The single brand accent — selected method, focus ring, links, the pieces
  // that currently render Stripe blue.
  const primary = color("--primary");
  if (primary) variables.colorPrimary = primary;

  // Validation/error text, matched to our destructive token.
  const danger = color("--destructive");
  if (danger) variables.colorDanger = danger;

  // Input borders (the one border color Stripe exposes as a variable) and our
  // radius scale, so fields share the storefront's shape.
  const inputBorder = color("--input");
  if (inputBorder) variables.inputColorBorder = inputBorder;
  const radius = raw("--radius"); // a length (e.g. "0.625rem"), not a color
  if (radius) variables.borderRadius = radius;

  return { theme, variables };
}
