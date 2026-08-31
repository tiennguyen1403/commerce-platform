import { prisma } from "@/server/db";

/**
 * Data-access for memberships (user ↔ tenant ↔ role). Tenant-scoped like every
 * other repository: the lookup is keyed by the `(userId, tenantId)` unique, so
 * a membership in one store can never resolve access to another. Mirrors the
 * `(tenantId, …)`-first shape of `product.repository.ts`.
 */
export const membershipRepository = {
  findForUser(tenantId: string, userId: string) {
    return prisma.membership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
    });
  },
};
