"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertRole } from "@/server/auth/admin-context";
import { InsufficientRoleError } from "@/server/auth/rbac.errors";
import { ROLES } from "@/config/roles";
import { settingsService } from "@/server/services/settings.service";
import {
  updateCurrencySchema,
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
  // `assertRole` → `requireAdminContext` can `redirect()` (session expired, no
  // membership), a control-flow throw Next must handle. Re-throw those first so
  // this catch never swallows a redirect into a generic message (and never
  // fires the error webhook for a non-error).
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
  input: unknown,
): Promise<SettingsActionResult> {
  try {
    const { tenantId } = await assertRole(ROLES.OWNER);

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
    revalidatePath("/admin/settings");
    revalidatePath("/admin/products");
    revalidatePath("/products");
    revalidatePath("/products/[slug]", "page");
    return { ok: true };
  } catch (err) {
    return mapSettingsError(err);
  }
}
