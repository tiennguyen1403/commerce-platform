import { z } from "zod";
import { ROLES, type Role } from "@/config/roles";

/**
 * Member management input shapes + display metadata, shared by the client forms
 * (UX validation) and the Server Actions (authoritative validation). Pure zod +
 * plain data: imported by client components, so it must never pull in a
 * `server-only` module. Role values come from `@/config/roles`, the single
 * source of truth for the hierarchy.
 */

// Assignable roles as a tuple (highest → lowest privilege), for `z.enum` and the
// role pickers. `satisfies` guarantees every entry is a real `Role` (catching a
// typo); keep it in sync with `ROLES`. `ROLE_LABELS` below is a `Record<Role>`,
// so adding a role to the union forces a label here too.
export const MEMBER_ROLES = [
  ROLES.OWNER,
  ROLES.ADMIN,
  ROLES.STAFF,
] as const satisfies readonly Role[];

export const ROLE_LABELS: Record<Role, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  STAFF: "Staff",
};

const roleSchema = z.enum(MEMBER_ROLES, { error: "Choose a role." });

export const addMemberSchema = z.object({
  // 254 is the practical RFC-5321 ceiling for a full email address.
  email: z.email({ error: "Enter a valid email address." }).max(254),
  role: roleSchema,
});
export type AddMemberInput = z.infer<typeof addMemberSchema>;

export const changeRoleSchema = z.object({
  userId: z.string().min(1, { error: "Missing member." }),
  role: roleSchema,
});
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;

/** Field-keyed messages surfaced back to the add-member form. */
export type MemberFieldErrors = { email?: string; role?: string };

/** Discriminated result every member Server Action returns to the client. */
export type MemberActionResult =
  | { ok: true }
  | { ok: false; formError?: string; fieldErrors?: MemberFieldErrors };
