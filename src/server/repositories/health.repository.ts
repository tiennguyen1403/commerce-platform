import { prisma } from "@/server/db";

/**
 * Data-access for health probes. The one repository with no `tenantId` scope: a
 * readiness check asks whether the *database itself* is reachable — a question
 * that sits below tenant isolation. Keeping the query here (not in the route)
 * is what satisfies golden rule #2: repositories are the only Prisma callers.
 */
export const healthRepository = {
  /** Cheapest possible round-trip; resolves if the DB answers, throws if not. */
  async ping(): Promise<void> {
    await prisma.$queryRaw`SELECT 1`;
  },
};
