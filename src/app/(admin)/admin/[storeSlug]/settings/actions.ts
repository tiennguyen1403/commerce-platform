"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertRole } from "@/server/auth/admin-context";
import { InsufficientRoleError } from "@/server/auth/rbac.errors";
import { ROLES } from "@/config/roles";
import { settingsService } from "@/server/services/settings.service";
import {
  updateCurrencySchema,
  updateNameSchema,
  updateThemeSchema,
  type SettingsActionResult,
} from "@/lib/validators/settings";
import { reportError } from "@/server/observability/error-reporter";

/**
 * Store-settings mutations. Every action re-checks OWNER server-side
 * (`assertRole` — render-time nav gating is not a security boundary, and Server
 * Actions are public endpoints) and re-validates the payload with the same zod
 * schema the form uses. The tenant is always the signed-in owner's, never
 * client-supplied.
 */

async function mapSettingsError(err: unknown): Promise<SettingsActionResult> {
  // `assertRole` → `requireAdminContext` can `redirect()` (no session) or
  // `notFound()` (unknown store / non-member), a control-flow throw Next must
  // handle. Re-throw those first so this catch never swallows one into a generic
  // message (and never fires the error webhook for a non-error).
  unstable_rethrow(err);

  if (err instanceof InsufficientRoleError) {
    return { ok: false, formError: err.message };
  }
  // An unexpected failure — none of the known domain errors. This action
  // swallows it and returns a friendly message, so Next's onRequestError hook
  // never sees it: report it here at the catch site.
  await reportError(err, { action: "settings-write" });
  return { ok: false, formError: "Something went wrong. Please try again." };
}

export async function updateStoreCurrencyAction(
  storeSlug: string,
  input: unknown,
): Promise<SettingsActionResult> {
  try {
    const { tenantId } = await assertRole(storeSlug, ROLES.OWNER);

    const parsed = updateCurrencySchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        fieldErrors: {
          currency:
            parsed.error.issues[0]?.message ?? "Choose a supported currency.",
        },
      };
    }

    await settingsService.updateStoreCurrency(tenantId, parsed.data.currency);

    // Every price shown inherits the store currency, so bust the catalog routes
    // the change re-labels: the storefront list + PDP and the admin product
    // pages. They render on demand, but revalidating from a Server Action also
    // drops any already-visited copies from the client router cache, so the new
    // label shows on next navigation without a hard reload. Cart/checkout read
    // live from the session/cookie, so they need no revalidation.
    revalidatePath(`/admin/${storeSlug}/settings`);
    revalidatePath(`/admin/${storeSlug}/products`);
    revalidatePath("/products");
    revalidatePath("/products/[slug]", "page");
    return { ok: true };
  } catch (err) {
    return mapSettingsError(err);
  }
}

export async function updateStoreNameAction(
  storeSlug: string,
  input: unknown,
): Promise<SettingsActionResult> {
  try {
    const { tenantId } = await assertRole(storeSlug, ROLES.OWNER);

    const parsed = updateNameSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        fieldErrors: {
          name: parsed.error.issues[0]?.message ?? "Enter a store name.",
        },
      };
    }

    await settingsService.updateStoreName(tenantId, parsed.data.name);

    // The name is the store's brand: it shows in the storefront header/footer
    // and across admin (the layout brand, the store switcher, and the `/admin`
    // multi-store picker). Bust all of those so the rename appears on next
    // navigation without a hard reload. The admin subtree is targeted by its
    // route pattern + `"layout"` (the idiom for a dynamic segment, matching the
    // storefront PDP below) — which refreshes the brand and switcher on every
    // admin page, for any store the switcher lists, not just this slug's pages.
    revalidatePath("/admin/[storeSlug]", "layout");
    revalidatePath("/admin");
    revalidatePath("/products");
    revalidatePath("/products/[slug]", "page");
    return { ok: true };
  } catch (err) {
    return mapSettingsError(err);
  }
}

export async function updateStoreThemeAction(
  storeSlug: string,
  input: unknown,
): Promise<SettingsActionResult> {
  try {
    const { tenantId } = await assertRole(storeSlug, ROLES.OWNER);

    const parsed = updateThemeSchema.safeParse(input);
    if (!parsed.success) {
      // The hue schema's messages are range-technical; the picker constrains
      // 0–359 anyway, so this server guard is defense-in-depth for a tampered
      // payload. Surface one friendly line rather than the raw zod text.
      return {
        ok: false,
        fieldErrors: { themeHue: "Pick a hue from 0 to 359." },
      };
    }

    await settingsService.updateStoreTheme(tenantId, parsed.data.themeHue);

    // The accent lives only in the storefront layout's inline `<style>` (built
    // per-tenant from `themeHue`, read live). Storefront routes are
    // `force-dynamic`, so they repaint with the new hue on their next request;
    // revalidating also drops any already-visited copies from the client router
    // cache, and refreshes this settings page so the picker's saved baseline
    // updates. The admin chrome isn't tenant-themed, so it needs no bust.
    revalidatePath(`/admin/${storeSlug}/settings`);
    revalidatePath("/products");
    revalidatePath("/products/[slug]", "page");
    return { ok: true };
  } catch (err) {
    return mapSettingsError(err);
  }
}
