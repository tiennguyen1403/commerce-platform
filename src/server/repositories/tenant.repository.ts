import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { ROLES } from "@/config/roles";
import { SlugTakenError } from "@/server/tenant.errors";

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

  /** Look up a tenant by id. Used to brand outbound email with the store's
   *  name, where only the `tenantId` (from PaymentIntent metadata) is on hand. */
  findById(id: string) {
    return prisma.tenant.findUnique({ where: { id } });
  },

  /**
   * Create a store and make `ownerId` its OWNER in one transaction: the tenant
   * and its first membership commit together or not at all, so a taken slug (or
   * any failure) never leaves an orphan tenant. Mirrors
   * `membership.repository.create` — a `slug` unique violation (P2002, e.g. two
   * people claiming the same subdomain at once) is translated to the typed
   * `SlugTakenError`; anything else propagates. The tenant is brand-new, so its
   * `(userId, tenantId)` membership unique can't collide here — `slug` is the
   * only reachable unique, and the friendly pre-check in the service catches the
   * common case before this backstop.
   */
  async createWithOwner(data: { slug: string; name: string }, ownerId: string) {
    try {
      return await prisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: { slug: data.slug, name: data.name },
        });
        await tx.membership.create({
          data: { tenantId: tenant.id, userId: ownerId, role: ROLES.OWNER },
        });
        return tenant;
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        throw new SlugTakenError();
      }
      throw err;
    }
  },

  /** Set the store's single currency (`Tenant.currency`). Scoped by the tenant's
   *  own id — the isolation root — so there's no cross-tenant reach. Touches
   *  only the currency column: existing `priceCents` are reinterpreted, never
   *  converted, and `Order.currency` snapshots stay historical (see the
   *  settings service). */
  updateCurrency(id: string, currency: string) {
    return prisma.tenant.update({ where: { id }, data: { currency } });
  },
};
