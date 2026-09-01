import type { Role } from "@/config/roles";
import { userRepository } from "@/server/repositories/user.repository";
import { membershipRepository } from "@/server/repositories/membership.repository";
import {
  LastOwnerError,
  MemberNotFoundError,
  MembershipExistsError,
  UserNotFoundError,
} from "@/server/membership.errors";

/**
 * Business logic for tenant membership (RBAC). Owns the friendly pre-checks and
 * the typed-error vocabulary; the repository owns the Prisma work and the atomic
 * last-owner guard. Shape validation (zod) happens at the Server Action
 * boundary. This layer stays free of Prisma.
 */

// Re-export so the Server Action boundary imports every membership error from
// one place, without reaching into the error module directly.
export {
  LastOwnerError,
  MemberNotFoundError,
  MembershipExistsError,
  UserNotFoundError,
} from "@/server/membership.errors";

export const membershipService = {
  listMembers(tenantId: string) {
    return membershipRepository.listByTenant(tenantId);
  },

  /**
   * Add an *existing* account to the tenant by email. Never creates the login:
   * an admin request calling `auth.api.signUpEmail` would overwrite the owner's
   * own session cookie via `nextCookies()` (a session-hijack bug). If no account
   * matches, `UserNotFoundError` tells the owner to have them sign up first.
   */
  async addMemberByEmail(tenantId: string, email: string, role: Role) {
    const normalized = email.trim().toLowerCase();
    const user = await userRepository.findByEmail(normalized);
    if (!user) throw new UserNotFoundError();

    // Friendly pre-check; the DB unique + repo mapping is the race-safe backstop.
    const existing = await membershipRepository.findForUser(tenantId, user.id);
    if (existing) throw new MembershipExistsError();

    return membershipRepository.create(tenantId, user.id, role);
  },

  /** Change a member's role; refuses to demote the tenant's last OWNER. */
  async changeRole(tenantId: string, userId: string, role: Role) {
    const result = await membershipRepository.changeRole(
      tenantId,
      userId,
      role,
    );
    if (!result.ok) {
      if (result.reason === "last_owner") throw new LastOwnerError();
      throw new MemberNotFoundError();
    }
  },

  /** Remove a member; refuses to remove the tenant's last OWNER. */
  async removeMember(tenantId: string, userId: string) {
    const result = await membershipRepository.remove(tenantId, userId);
    if (!result.ok) {
      if (result.reason === "last_owner") throw new LastOwnerError();
      throw new MemberNotFoundError();
    }
  },
};
