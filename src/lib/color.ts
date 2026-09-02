/**
 * OKLCH → sRGB color resolution.
 *
 * Our design tokens are authored in OKLCH (`src/app/globals.css`). Most of the
 * app never needs to leave that space — Tailwind/CSS render `oklch()` natively.
 * The exception is a foreign surface that can't read our tokens or parse
 * `oklch()`: Stripe's Payment Element runs in its own cross-origin iframe, whose
 * document can't see our `:root` custom properties (custom properties are
 * document-scoped), and whose Appearance API only reliably accepts plain sRGB
 * colors. So we resolve tokens to concrete sRGB strings *at that boundary* — the
 * same "format only at the edge" rule as `formatMoney`.
 *
 * The transform is Björn Ottosson's OKLab pipeline (oklch → OKLab → LMS → linear
 * sRGB → gamma-encoded sRGB). Channels are clamped into gamut before gamma
 * encoding, and that clamp is load-bearing, not cosmetic: a couple of our tokens
 * (light `--primary` and `--destructive`) land a hair outside sRGB — one channel
 * around −0.01 — and `(negative) ** (1 / 2.4)` is `NaN`, so the clamp is what
 * keeps the hex valid (and is marginally lossy for exactly those two). Clipping
 * is per-channel, so a much higher-chroma future accent could shift hue slightly;
 * today's near-neutral ramp plus one emerald accent clip imperceptibly — outputs
 * match Tailwind's own sRGB palette.
 */

export type OklchColor = {
  /** Perceptual lightness, 0–1. */
  l: number;
  /** Chroma, ≥ 0. */
  c: number;
  /** Hue angle in degrees. */
  h: number;
  /** Alpha, 0–1. */
  alpha: number;
};

/** Pull the numeric value out of a component, honoring `%`, `deg`, and `none`. */
function parseComponent(raw: string, percentOf: number): number {
  const token = raw.trim();
  if (token === "" || token === "none") return 0;
  if (token.endsWith("%")) {
    return (Number.parseFloat(token) / 100) * percentOf;
  }
  // Hue may carry an angle unit; only degrees appear in our tokens, and
  // `parseFloat` ignores a trailing `deg`/`rad` suffix — degrees is the CSS
  // default, which is what our tokens use.
  return Number.parseFloat(token);
}

/**
 * Parse a CSS `oklch(...)` string into its components, or `null` if the input
 * isn't a well-formed `oklch()` value (e.g. a non-color token like `0.625rem`,
 * an empty read, or a different color space). Callers use `null` to skip a
 * token and fall back to the base theme rather than emit a broken color.
 */
export function parseOklch(input: string): OklchColor | null {
  const match = /^oklch\(([^)]*)\)$/i.exec(input.trim());
  if (!match) return null;

  // Split off the optional `/ <alpha>` first, then the three space-separated
  // L C H components (CSS allows arbitrary whitespace between them).
  const [main, alphaRaw] = match[1].split("/");
  const parts = main.trim().split(/\s+/);
  if (parts.length !== 3) return null;

  const l = parseComponent(parts[0], 1);
  const c = parseComponent(parts[1], 0.4);
  const h = parseComponent(parts[2], 1);
  const alpha =
    alphaRaw === undefined
      ? 1
      : Math.min(1, Math.max(0, parseComponent(alphaRaw, 1)));

  if (!Number.isFinite(l) || !Number.isFinite(c) || !Number.isFinite(h)) {
    return null;
  }
  return { l, c, h, alpha };
}

/**
 * Gamma-encode one linear-sRGB channel to an 8-bit value, clamping out-of-gamut
 * inputs into [0, 1] first — this is what guards against a `NaN` from a
 * slightly-negative channel (see the file header).
 */
function encodeChannel(linear: number): number {
  const clamped = Math.min(1, Math.max(0, linear));
  const srgb =
    clamped <= 0.0031308
      ? 12.92 * clamped
      : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return Math.round(srgb * 255);
}

function toHex(n: number): string {
  return n.toString(16).padStart(2, "0");
}

/**
 * Resolve a CSS `oklch(...)` string to an sRGB color string usable by Stripe's
 * Appearance API: `#rrggbb` when opaque, `rgba(r, g, b, a)` when the token
 * carries alpha (e.g. our translucent dark-mode borders). Returns `null` for
 * anything that isn't a parseable `oklch()` value.
 */
export function oklchToSrgb(input: string): string | null {
  const parsed = parseOklch(input);
  if (!parsed) return null;
  const { l: lightness, c: chroma, h, alpha } = parsed;

  const hueRad = (h * Math.PI) / 180;
  const a = chroma * Math.cos(hueRad);
  const b = chroma * Math.sin(hueRad);

  // OKLab → LMS (cube-rooted), then cube back to linear LMS.
  const lCbrt = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mCbrt = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sCbrt = lightness - 0.0894841775 * a - 1.291485548 * b;
  const lLms = lCbrt ** 3;
  const mLms = mCbrt ** 3;
  const sLms = sCbrt ** 3;

  // LMS → linear sRGB.
  const r = 4.0767416621 * lLms - 3.3077115913 * mLms + 0.2309699292 * sLms;
  const g = -1.2684380046 * lLms + 2.6097574011 * mLms - 0.3413193965 * sLms;
  const bl = -0.0041960863 * lLms - 0.7034186147 * mLms + 1.707614701 * sLms;

  const r8 = encodeChannel(r);
  const g8 = encodeChannel(g);
  const b8 = encodeChannel(bl);

  if (alpha >= 1) {
    return `#${toHex(r8)}${toHex(g8)}${toHex(b8)}`;
  }
  // Trim alpha to at most 4 decimals without trailing zeros (0.1, 0.15, …).
  return `rgba(${r8}, ${g8}, ${b8}, ${Number(alpha.toFixed(4))})`;
}
