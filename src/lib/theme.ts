import { z } from "zod";

/**
 * Per-tenant storefront accent theming.
 *
 * Each store carries a single hue (`Tenant.themeHue`, an OKLCH hue angle). The
 * storefront layout wraps its subtree in `[data-tenant-theme]` and injects the
 * CSS this module builds, which re-parametrizes the accent tokens by that hue —
 * so two stores render distinct accents from one shared recipe, SSR'd and
 * theme-aware, with no cross-tenant bleed: the override lives on the wrapper, not
 * `:root`, so it never reaches the `(admin)`/`(auth)` trees rendered as siblings
 * under the root layout.
 *
 * Only the *hue-carrying* tokens are overridden; lightness and chroma are copied
 * verbatim from `globals.css`, so a store on {@link DEFAULT_THEME_HUE} is a
 * pixel-for-pixel no-op. Everything neutral (background, text, borders) is left
 * untouched — a store gets its own accent, not a full re-skin.
 */

/**
 * The platform's default accent hue — emerald (see docs/DESIGN.md). Matches the
 * `162` in every accent token in `globals.css` (and the `Tenant.themeHue` column
 * default in `schema.prisma`), so a tenant on this hue renders identically to the
 * base theme. Also the fallback for an invalid stored value.
 */
export const DEFAULT_THEME_HUE = 162;

/**
 * Selector for the storefront theme wrapper. The layout stamps this attribute on
 * its root element; the generated CSS ({@link tenantThemeCss}) and the checkout
 * appearance both target it. Shared here so the three sides can never drift.
 */
export const TENANT_THEME_SELECTOR = "[data-tenant-theme]";

/**
 * A valid OKLCH hue: an integer degree in [0, 359]. This is the CSS-injection
 * boundary — only a bare integer can reach the interpolated `oklch()` string —
 * and it rejects out-of-range/non-integer values (NaN included, via `.int()`) so
 * a bad stored hue falls back to the default instead of emitting broken CSS.
 */
export const themeHueSchema = z.number().int().min(0).max(359);

/**
 * Coerce a stored hue to a safe value. Returns the hue when it's a valid integer
 * degree, else {@link DEFAULT_THEME_HUE}. The column defaults to a valid hue and
 * a future store-settings editor will validate on the way in, so an invalid value
 * is only reachable by a raw DB write — this keeps even that from breaking a page.
 */
export function resolveThemeHue(raw: number): number {
  const parsed = themeHueSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_THEME_HUE;
}

/**
 * The hue-carrying subset of the OKLCH token recipe in `globals.css`, as
 * `[token, lightness, chroma]` tuples per color scheme. The per-tenant hue is
 * injected into each; L and C are copied verbatim from `:root` / the dark
 * `@media` block, so {@link DEFAULT_THEME_HUE} reproduces the base theme exactly.
 * Keep in sync with `globals.css` — these are the only tokens whose value depends
 * on the accent. (Light `--primary-foreground` is achromatic, so its hue is inert;
 * it's kept in the recipe for a uniform light/dark shape.)
 */
const TOKEN_RECIPE: Record<
  "light" | "dark",
  ReadonlyArray<readonly [token: string, l: number, c: number]>
> = {
  light: [
    ["--primary", 0.5, 0.12],
    ["--primary-foreground", 0.985, 0],
    ["--accent", 0.96, 0.02],
    ["--accent-foreground", 0.35, 0.09],
    ["--ring", 0.55, 0.13],
  ],
  dark: [
    ["--primary", 0.72, 0.14],
    ["--primary-foreground", 0.18, 0.02],
    ["--accent", 0.27, 0.02],
    ["--accent-foreground", 0.9, 0.03],
    ["--ring", 0.62, 0.13],
  ],
};

function declarations(
  tokens: (typeof TOKEN_RECIPE)["light"],
  hue: number,
): string {
  return tokens
    .map(([name, l, c]) => `${name}:oklch(${l} ${c} ${hue});`)
    .join("");
}

/**
 * Build the scoped `<style>` body that re-themes the storefront to `hue`. Emits
 * the light recipe on the wrapper and the dark recipe inside the same
 * `prefers-color-scheme: dark` media query `globals.css` uses, so the wrapper's
 * accent follows the OS scheme exactly like the base tokens do. `hue` is
 * validated here (the interpolation boundary), so any caller value is safe.
 */
export function tenantThemeCss(hue: number): string {
  const safe = resolveThemeHue(hue);
  return (
    `${TENANT_THEME_SELECTOR}{${declarations(TOKEN_RECIPE.light, safe)}}\n` +
    `@media (prefers-color-scheme:dark){` +
    `${TENANT_THEME_SELECTOR}{${declarations(TOKEN_RECIPE.dark, safe)}}}`
  );
}
