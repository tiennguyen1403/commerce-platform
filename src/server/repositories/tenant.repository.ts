import { prisma } from "@/server/db";

/**
 * Data-access for tenants. The tenant sits at the top of the isolation
 * hierarchy, so this is the one repository whose lookup isn't itself scoped by
 * a `tenantId` — every other query derives its tenant from here. Services call
 * repositories; routes and pages never touch Prisma directly.
 */
export const tenantRepository = {
  findBySlug(slug: string) {
    return prisma.tenant.findUnique({ where: { slug } });
  },
};
