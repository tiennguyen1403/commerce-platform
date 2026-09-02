"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import type { ZodError } from "zod";
import { assertRole } from "@/server/auth/admin-context";
import { InsufficientRoleError } from "@/server/auth/rbac.errors";
import { ROLES } from "@/config/roles";
import {
  membershipService,
  LastOwnerError,
  MemberNotFoundError,
  MembershipExistsError,
  UserNotFoundError,
} from "@/server/services/membership.service";
import {
  addMemberSchema,
  changeRoleSchema,
  type MemberActionResult,
  type MemberFieldErrors,
} from "@/lib/validators/members";
import { reportError } from "@/server/observability/error-reporter";

/**
 * Member management mutations. Every action re-checks OWNER server-side
 * (`assertRole` — render-time nav gating is not a security boundary, and Server
 * Actions are public endpoints) and re-validates the payload with the same zod
 * schema the form uses. The tenant is always the signed-in owner's, never
 * client-supplied.
 */

/** First zod message per field the add-member form knows about. */
function fieldErrorsFromZod(error: ZodError): MemberFieldErrors {
  const out: MemberFieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (key === "email" && !out.email) out.email = issue.message;
    if (key === "role" && !out.role) out.role = issue.message;
  }
  return out;
}

/** Map a thrown error to the client result — typed domain errors to their
 *  field/form slot, anything else reported and shown as a generic message. */
async function mapMemberError(err: unknown): Promise<MemberActionResult> {
  // `assertRole` → `requireAdminContext` can `redirect()` (session expired, no
  // membership), which throws a control-flow error Next must handle. Re-throw
  // those first so this catch never swallows a redirect into a generic message
  // (and never fires the error webhook for a non-error).
  unstable_rethrow(err);

  if (err instanceof InsufficientRoleError) {
    return { ok: false, formError: err.message };
  }
  if (
    err instanceof UserNotFoundError ||
    err instanceof MembershipExistsError
  ) {
    return { ok: false, fieldErrors: { email: err.message } };
  }
  if (err instanceof LastOwnerError || err instanceof MemberNotFoundError) {
    return { ok: false, formError: err.message };
  }
  // An unexpected failure — none of the known domain errors. This action
  // swallows it and returns a friendly message, so Next's onRequestError hook
  // never sees it: report it here at the catch site.
  await reportError(err, { action: "members-write" });
  return { ok: false, formError: "Something went wrong. Please try again." };
}

export async function addMemberAction(
  input: unknown,
): Promise<MemberActionResult> {
  try {
    const { tenantId } = await assertRole(ROLES.OWNER);

    const parsed = addMemberSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, fieldErrors: fieldErrorsFromZod(parsed.error) };
    }

    await membershipService.addMemberByEmail(
      tenantId,
      parsed.data.email,
      parsed.data.role,
    );
    revalidatePath("/admin/members");
    return { ok: true };
  } catch (err) {
    return mapMemberError(err);
  }
}

export async function changeMemberRoleAction(
  userId: string,
  role: string,
): Promise<MemberActionResult> {
  try {
    const { tenantId, userId: actingUserId } = await assertRole(ROLES.OWNER);

    // Managing your own membership from here is forbidden (mirrors the disabled
    // row control) — enforced server-side too, since actions are public.
    if (userId === actingUserId) {
      return { ok: false, formError: "You can't change your own role here." };
    }

    const parsed = changeRoleSchema.safeParse({ userId, role });
    if (!parsed.success) {
      return { ok: false, formError: "Choose a valid role." };
    }

    await membershipService.changeRole(
      tenantId,
      parsed.data.userId,
      parsed.data.role,
    );
    revalidatePath("/admin/members");
    return { ok: true };
  } catch (err) {
    return mapMemberError(err);
  }
}

export async function removeMemberAction(
  userId: string,
): Promise<MemberActionResult> {
  try {
    const { tenantId, userId: actingUserId } = await assertRole(ROLES.OWNER);
    if (!userId) return { ok: false, formError: "Missing member." };
    if (userId === actingUserId) {
      return { ok: false, formError: "You can't remove yourself." };
    }

    await membershipService.removeMember(tenantId, userId);
    revalidatePath("/admin/members");
    return { ok: true };
  } catch (err) {
    return mapMemberError(err);
  }
}
