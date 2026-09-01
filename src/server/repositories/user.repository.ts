import "server-only";
import { prisma } from "@/server/db";

/**
 * Data-access for the Better Auth `User` table. Users are global (not
 * tenant-scoped) — a person has one account and can belong to many tenants
 * through `Membership`, which is where the tenant scope lives. Services call
 * repositories; routes and pages never touch Prisma directly.
 */
export const userRepository = {
  /**
   * Look up an account by email. Better Auth normalizes email to lowercase on
   * sign-up (`sign-up.mjs`: `email.toLowerCase()`), so the caller passes a
   * lowercased address and this hits the unique index directly. Returns null
   * when no account exists — the members flow turns that into a friendly
   * "ask them to sign up first" rather than creating the login itself.
   */
  findByEmail(email: string) {
    return prisma.user.findUnique({ where: { email } });
  },
};
