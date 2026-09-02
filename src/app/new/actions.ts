"use server";

import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import type { ZodError } from "zod";
import { auth } from "@/server/auth";
import {
  createStoreSchema,
  type StoreActionResult,
  type StoreFieldErrors,
} from "@/lib/validators/tenant";
import {
  tenantService,
  InvalidSlugError,
  ReservedSlugError,
  SlugTakenError,
} from "@/server/services/tenant.service";
import { reportError } from "@/server/observability/error-reporter";

/**
 * Self-serve store creation — the one write action not scoped by an incoming
 * `storeSlug`. It re-derives the session server-side (Server Actions are public
 * endpoints, so a client-supplied user id is never trusted) and makes that user
 * the new store's OWNER. It never touches the session cookie: calling
 * `auth.api.signUpEmail`/`signInEmail` here would overwrite the caller's session
 * via `nextCookies()` — sign-up stays client-driven on the auth pages.
 */

/** First zod message per field the create-store form knows about. */
function fieldErrorsFromZod(error: ZodError): StoreFieldErrors {
  const out: StoreFieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (key === "name" && !out.name) out.name = issue.message;
    if (key === "slug" && !out.slug) out.slug = issue.message;
  }
  return out;
}

/** Map a thrown error to the client result — every typed slug error lands on the
 *  slug field; anything else is reported and shown as a generic message. */
async function mapError(err: unknown): Promise<StoreActionResult> {
  // Re-throw control-flow errors (redirect/notFound) first so this catch never
  // swallows one into a generic message or fires the error webhook for a non-error.
  unstable_rethrow(err);

  if (
    err instanceof SlugTakenError ||
    err instanceof ReservedSlugError ||
    err instanceof InvalidSlugError
  ) {
    return { ok: false, fieldErrors: { slug: err.message } };
  }
  await reportError(err, { action: "create-store" });
  return { ok: false, formError: "Something went wrong. Please try again." };
}

export async function createStoreAction(
  input: unknown,
): Promise<StoreActionResult> {
  try {
    // Authoritative gate: re-derive the session here, never trust the caller.
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) {
      return {
        ok: false,
        formError: "Your session has expired. Please sign in again.",
      };
    }

    const parsed = createStoreSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, fieldErrors: fieldErrorsFromZod(parsed.error) };
    }

    const tenant = await tenantService.createStore(
      session.user.id,
      parsed.data,
    );
    return { ok: true, slug: tenant.slug };
  } catch (err) {
    return mapError(err);
  }
}
