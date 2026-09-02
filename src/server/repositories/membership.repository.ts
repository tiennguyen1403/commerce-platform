import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import type { Role } from "@/config/roles";
import { MembershipExistsError } from "@/server/membership.errors";

/**
 * Data-access for memberships (user ↔ tenant ↔ role). Tenant-scoped like every
 * other repository: reads and writes are keyed by the `(userId, tenantId)`
 * unique or filtered by `tenantId`, so a membership in one store can never
 * resolve or mutate access in another. Mirrors the `(tenantId, …)`-first shape
 * of `product.repository.ts`; Prisma unique failures are translated here.
 */

/**
 * Outcome of an owner-guarded write. The last-OWNER rule can't be a DB
 * constraint, so — like `product.repository.archive` returning a row count —
 * the repository reports the outcome as data and the service turns it into the
 * typed domain error (`LastOwnerError` / `MemberNotFoundError`).
 */
export type GuardedWriteResult =
  { ok: true } | { ok: false; reason: "not_found" | "last_owner" };

export const membershipRepository = {
  findForUser(tenantId: string, userId: string) {
    return prisma.membership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
    });
  },

  /**
   * Every store a user belongs to — their role plus the tenant's slug/name — for
   * the `/admin` store index and switcher. This is the one deliberately
   * cross-tenant read: it's scoped by the caller's own `userId` (their
   * memberships), so it surfaces only stores they're actually a member of, never
   * another user's. Ordered by store name for a stable list.
   */
  listForUser(userId: string) {
    return prisma.membership.findMany({
      where: { userId },
      select: {
        role: true,
        tenant: { select: { slug: true, name: true } },
      },
      orderBy: { tenant: { name: "asc" } },
    });
  },

  /**
   * All members of a tenant with the display fields the admin table needs.
   * Ordered by role then join date: Postgres sorts an enum by its declared
   * order (`OWNER`, `ADMIN`, `STAFF` — see the init migration), which is exactly
   * highest-privilege-first, with the earliest-added breaking ties.
   */
  listByTenant(tenantId: string) {
    return prisma.membership.findMany({
      where: { tenantId },
      select: {
        userId: true,
        role: true,
        createdAt: true,
        user: { select: { name: true, email: true } },
      },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    });
  },

  countOwners(tenantId: string) {
    return prisma.membership.count({ where: { tenantId, role: "OWNER" } });
  },

  /** Add an existing user to the tenant. Translates the `(userId, tenantId)`
   *  unique violation (a concurrent add) into `MembershipExistsError`. */
  async create(tenantId: string, userId: string, role: Role) {
    try {
      return await prisma.membership.create({
        data: { tenantId, userId, role },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        throw new MembershipExistsError();
      }
      throw err;
    }
  },

  /**
   * Change a member's role, refusing to demote the tenant's last OWNER. The
   * guard must be atomic with the write, so the whole check runs in one
   * transaction that first takes a `FOR UPDATE` lock on the tenant's OWNER rows:
   * any concurrent demote/remove of an owner then serializes behind it and the
   * count below is stable (no last-owner TOCTOU). Only removing owners can break
   * the invariant, and those rows are the ones locked — a concurrent *add* only
   * ever makes the count larger, never orphaning the tenant.
   */
  changeRole(
    tenantId: string,
    userId: string,
    role: Role,
  ): Promise<GuardedWriteResult> {
    return prisma.$transaction(async (tx): Promise<GuardedWriteResult> => {
      await tx.$queryRaw`SELECT "id" FROM "Membership" WHERE "tenantId" = ${tenantId} AND "role"::text = 'OWNER' FOR UPDATE`;

      const target = await tx.membership.findUnique({
        where: { userId_tenantId: { userId, tenantId } },
        select: { role: true },
      });
      if (!target) return { ok: false, reason: "not_found" };

      // Only a demotion away from OWNER can breach the invariant.
      if (target.role === "OWNER" && role !== "OWNER") {
        const owners = await tx.membership.count({
          where: { tenantId, role: "OWNER" },
        });
        if (owners <= 1) return { ok: false, reason: "last_owner" };
      }

      await tx.membership.update({
        where: { userId_tenantId: { userId, tenantId } },
        data: { role },
      });
      return { ok: true };
    });
  },

  /**
   * Remove a member, refusing to remove the tenant's last OWNER. Same atomic
   * `FOR UPDATE` guard as `changeRole` — see that method for why the lock closes
   * the last-owner race.
   */
  remove(tenantId: string, userId: string): Promise<GuardedWriteResult> {
    return prisma.$transaction(async (tx): Promise<GuardedWriteResult> => {
      await tx.$queryRaw`SELECT "id" FROM "Membership" WHERE "tenantId" = ${tenantId} AND "role"::text = 'OWNER' FOR UPDATE`;

      const target = await tx.membership.findUnique({
        where: { userId_tenantId: { userId, tenantId } },
        select: { role: true },
      });
      if (!target) return { ok: false, reason: "not_found" };

      if (target.role === "OWNER") {
        const owners = await tx.membership.count({
          where: { tenantId, role: "OWNER" },
        });
        if (owners <= 1) return { ok: false, reason: "last_owner" };
      }

      await tx.membership.delete({
        where: { userId_tenantId: { userId, tenantId } },
      });
      return { ok: true };
    });
  },
};
