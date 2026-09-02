import { afterAll, afterEach, describe, expect, it } from "vitest";
import { tenantRepository } from "@/server/repositories/tenant.repository";
import { SlugTakenError } from "@/server/tenant.errors";
import { deleteTenantDeep, prisma, uniqueId } from "@/test/integration-db";

/**
 * Integration tests for `tenantRepository.createWithOwner` against a real
 * Postgres — the crux of self-serve onboarding's "no partial writes"
 * guarantee. The tenant and its first OWNER membership must commit together
 * or not at all; a mock can't exercise the `$transaction` rollback or the
 * P2002 unique-slug race, so this runs against the same Postgres the app
 * uses.
 */

// Each test gets its own throwaway user — the FK `Membership.userId → User`
// needs a real row — and any tenants it creates; clean both up afterwards
// (scoped, not a truncation) so a shared local database doesn't accumulate
// rows across runs. Tenants are deleted first: `Membership` cascades from
// both `Tenant` and `User` (see schema), so removing the tenant frees its
// membership without a separate delete, leaving the user FK-free to remove.
const tenantIds: string[] = [];
const userIds: string[] = [];

/** Create a throwaway `User` row to own a store. A bare `prisma.user.create`
 *  (no `Account`) can't sign in via Better Auth, but that's irrelevant here —
 *  the repository only needs a real id to satisfy the membership FK. */
async function freshUser() {
  const user = await prisma.user.create({
    data: {
      id: uniqueId("user"),
      name: "Test Owner",
      email: `${uniqueId("owner")}@example.com`,
    },
  });
  userIds.push(user.id);
  return user;
}

afterEach(async () => {
  await Promise.all(tenantIds.splice(0).map(deleteTenantDeep));
  await prisma.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("tenantRepository.createWithOwner (integration)", () => {
  it("creates the tenant and an OWNER membership for the owner, atomically", async () => {
    const owner = await freshUser();
    const slug = uniqueId("store");

    const tenant = await tenantRepository.createWithOwner(
      { slug, name: "Ada's Shop" },
      owner.id,
    );
    tenantIds.push(tenant.id);
    expect(tenant).toMatchObject({ slug, name: "Ada's Shop" });

    const persistedTenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: tenant.id },
    });
    expect(persistedTenant).toMatchObject({ slug, name: "Ada's Shop" });

    const membership = await prisma.membership.findUniqueOrThrow({
      where: { userId_tenantId: { userId: owner.id, tenantId: tenant.id } },
    });
    expect(membership.role).toBe("OWNER");
  });

  it("writes nothing when the slug is already taken (atomic P2002 backstop)", async () => {
    const owner = await freshUser();
    const slug = uniqueId("store");

    // A different store already claimed this slug — unrelated to `owner`.
    const existing = await prisma.tenant.create({
      data: { slug, name: "Existing Store" },
    });
    tenantIds.push(existing.id);

    await expect(
      tenantRepository.createWithOwner({ slug, name: "Ada's Shop" }, owner.id),
    ).rejects.toBeInstanceOf(SlugTakenError);

    // No second tenant claimed the slug — still exactly the pre-existing one.
    expect(await prisma.tenant.count({ where: { slug } })).toBe(1);
    // The failed attempt never reached the membership insert (the transaction
    // rolled back on the tenant-create collision): no orphan membership for
    // this owner anywhere.
    expect(await prisma.membership.count({ where: { userId: owner.id } })).toBe(
      0,
    );
  });
});
