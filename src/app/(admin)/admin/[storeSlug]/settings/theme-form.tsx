"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw } from "lucide-react";
import { updateThemeSchema } from "@/lib/validators/settings";
import { DEFAULT_THEME_HUE, accentPreview } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { updateStoreThemeAction } from "./actions";

// A few well-spaced starting points across the OKLCH wheel — a quick pick for
// owners who don't want to nudge a slider. Emerald is the platform default
// (`DEFAULT_THEME_HUE`), so a store starts on the first swatch.
const PRESETS: ReadonlyArray<{ name: string; hue: number }> = [
  { name: "Emerald", hue: DEFAULT_THEME_HUE },
  { name: "Teal", hue: 195 },
  { name: "Blue", hue: 245 },
  { name: "Violet", hue: 290 },
  { name: "Rose", hue: 5 },
  { name: "Amber", hue: 65 },
];

// The full hue wheel as the slider's track, so dragging reads as "move along the
// spectrum". Fixed L/C (a legible mid-tone) — only the hue turns.
const HUE_GRADIENT = `linear-gradient(to right, ${Array.from(
  { length: 13 },
  (_, i) => `oklch(0.7 0.14 ${i * 30})`,
).join(", ")})`;

// Native range inputs can't show a custom track + thumb without `appearance:
// none`, and thumb styling only lives in pseudo-elements — so this one control's
// chrome is a scoped stylesheet. Neutral thumb (platform tokens) over the
// rainbow track; the settings page renders a single instance.
const SLIDER_CSS = `
.accent-hue-slider{-webkit-appearance:none;appearance:none;width:100%;height:0.625rem;border-radius:9999px;cursor:pointer;}
.accent-hue-slider:focus-visible{outline:2px solid var(--ring);outline-offset:3px;}
.accent-hue-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:1.125rem;height:1.125rem;border-radius:9999px;background:var(--background);border:2px solid var(--foreground);box-shadow:0 1px 3px rgb(0 0 0 / 0.3);}
.accent-hue-slider::-moz-range-thumb{height:1.125rem;width:1.125rem;border-radius:9999px;background:var(--background);border:2px solid var(--foreground);box-shadow:0 1px 3px rgb(0 0 0 / 0.3);}
`;

/**
 * Views and changes the store's storefront accent (`Tenant.themeHue`, an OKLCH
 * hue angle). The picker previews the accent live — a swatch and a sample CTA in
 * the chosen hue — because the admin itself keeps the platform theme (it renders
 * outside the storefront's `[data-tenant-theme]` wrapper), so this is the only
 * place an owner sees their accent before it ships. A hue change is instantly
 * reversible, so there's no confirmation step. The server
 * (`updateStoreThemeAction`) stays the authoritative validation + OWNER boundary.
 */
export function ThemeForm({
  storeSlug,
  currentHue,
}: {
  storeSlug: string;
  currentHue: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [hue, setHue] = useState(currentHue);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const changed = hue !== currentHue;
  const accent = accentPreview(hue);

  function select(next: number) {
    setHue(next);
    setSaved(false);
  }

  function onSave() {
    const parsed = updateThemeSchema.safeParse({ themeHue: hue });
    if (!parsed.success) {
      setError("Pick a hue from 0 to 359.");
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await updateStoreThemeAction(storeSlug, parsed.data);
      if (result.ok) {
        setSaved(true);
        // Re-read so this card's saved baseline updates (disarming Save). The
        // storefront, on its own host, picks the hue up on its next request.
        router.refresh();
        return;
      }
      setError(
        result.formError ??
          result.fieldErrors?.themeHue ??
          "Couldn’t save the accent.",
      );
    });
  }

  return (
    <Card>
      <style dangerouslySetInnerHTML={{ __html: SLIDER_CSS }} />
      <CardHeader>
        <CardTitle>Accent color</CardTitle>
        <CardDescription>
          Your storefront’s accent — buttons, links, and highlights. The admin
          keeps the platform theme.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {/* Live preview: the accent as the storefront will render it. */}
        <div className="bg-muted/40 flex items-center gap-4 rounded-lg border p-4">
          <div
            aria-hidden
            className="size-11 shrink-0 rounded-lg border"
            style={{ background: accent.primary }}
          />
          <span
            aria-hidden
            className="inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium"
            style={{
              background: accent.primary,
              color: accent.primaryForeground,
            }}
          >
            Add to cart
          </span>
          <span className="text-muted-foreground ml-auto text-sm">Preview</span>
        </div>

        {/* Hue slider across the full wheel. */}
        <Field>
          <FieldLabel htmlFor="accent-hue" className="w-full justify-between">
            <span>Hue</span>
            <span className="text-muted-foreground tabular-nums">{hue}°</span>
          </FieldLabel>
          <input
            id="accent-hue"
            type="range"
            min={0}
            max={359}
            step={1}
            value={hue}
            aria-valuetext={`${hue} degrees`}
            className="accent-hue-slider"
            style={{ background: HUE_GRADIENT }}
            onChange={(e) => select(Number(e.target.value))}
          />
        </Field>

        {/* Preset quick-picks. */}
        <div className="flex flex-col gap-2">
          <span className="text-muted-foreground text-sm">Presets</span>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((preset) => {
              const isActive = hue === preset.hue;
              return (
                <button
                  key={preset.name}
                  type="button"
                  onClick={() => select(preset.hue)}
                  aria-label={`Use ${preset.name} accent`}
                  aria-pressed={isActive}
                  title={preset.name}
                  className={cn(
                    "focus-visible:ring-ring/50 size-7 rounded-full border transition-[box-shadow,transform] outline-none focus-visible:ring-[3px]",
                    isActive
                      ? "ring-ring ring-offset-background scale-110 ring-2 ring-offset-2"
                      : "hover:scale-105",
                  )}
                  style={{ background: accentPreview(preset.hue).primary }}
                />
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={onSave} disabled={!changed || pending}>
            {pending ? <Loader2 className="animate-spin" /> : null}
            Save accent
          </Button>
          {hue !== DEFAULT_THEME_HUE ? (
            <Button
              variant="ghost"
              onClick={() => select(DEFAULT_THEME_HUE)}
              disabled={pending}
            >
              <RotateCcw />
              Reset to default
            </Button>
          ) : null}
        </div>

        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        {saved && !error ? (
          <p role="status" className="text-muted-foreground text-sm">
            Accent saved. Your storefront will use it right away.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
