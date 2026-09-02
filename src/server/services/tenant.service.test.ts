import { describe, it, expect, beforeEach, vi } from "vitest";
import { tenantRepository } from "@/server/repositories/tenant.repository";
import {
  tenantService,
  InvalidSlugError,
  ReservedSlugError,
  SlugTakenError,
} from "@/server/services/tenant.service";

/**
 * Unit tests for the tenant service's self-serve onboarding write path, with
 * the tenant repository mocked. The focus is the business rules the service
 * owns — slug normalization, the shape/length/reserved-word gate (and the
 * order those checks run in), and the friendly slug-uniqueness pre-check
 * (translated to `SlugTakenError`) — not the repository's own Prisma/
 * transaction work.
 */

vi.mock("@/server/repositories/tenant.repository", () => ({
  tenantRepository: {
    findBySlug: vi.fn(),
    createWithOwner: vi.fn(),
  },
}));

const findBySlug = vi.mocked(tenantRepository.findBySlug);
const createWithOwner = vi.mocked(tenantRepository.createWithOwner);

const OWNER_ID = "owner_1";

type TenantRow = NonNullable<
  Awaited<ReturnType<typeof tenantRepository.findBySlug>>
>;

function tenantRow(
  o: { id?: string; slug?: string; name?: string } = {},
): TenantRow {
  return {
    id: o.id ?? "tenant_1",
    slug: o.slug ?? "ada-shop",
    name: o.name ?? "Ada's Shop",
    currency: "usd",
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    updatedAt: new Date("2025-01-01T00:00:00.000Z"),
  };
}

beforeEach(() => {
  // Reset (not just clear) so a test that forgets to arm the repo can't
  // inherit a previous test's return value.
  vi.resetAllMocks();
});

describe("tenantService.createStore", () => {
  it.each(["ab", "a".repeat(64), "a b", "a_b", "-lead", "trail-"])(
    "rejects the invalid slug %j, without a repository call",
    async (slug) => {
      await expect(
        tenantService.createStore(OWNER_ID, { name: "Ada's Shop", slug }),
      ).rejects.toBeInstanceOf(InvalidSlugError);
      expect(findBySlug).not.toHaveBeenCalled();
      expect(createWithOwner).not.toHaveBeenCalled();
    },
  );

  // "admin"/"www" are valid-shaped (3+ lowercase letters, no bad chars), so
  // throwing ReservedSlugError here — not InvalidSlugError — proves the
  // reserved-word gate runs, and runs after shape validation passes. "ADMIN"
  // additionally proves the reserved check runs against the lowercased slug
  // (RESERVED_SUBDOMAINS holds only lowercase entries) — not the raw input.
  it.each(["admin", "www", "ADMIN"])(
    "rejects the reserved slug %s as ReservedSlugError, without creating",
    async (slug) => {
      await expect(
        tenantService.createStore(OWNER_ID, { name: "Ada's Shop", slug }),
      ).rejects.toBeInstanceOf(ReservedSlugError);
      expect(findBySlug).not.toHaveBeenCalled();
      expect(createWithOwner).not.toHaveBeenCalled();
    },
  );

  it("throws SlugTakenError when the slug is already in use, without creating", async () => {
    findBySlug.mockResolvedValue(tenantRow({ slug: "ada-shop" }));

    await expect(
      tenantService.createStore(OWNER_ID, {
        name: "Ada's Shop",
        slug: "ada-shop",
      }),
    ).rejects.toBeInstanceOf(SlugTakenError);
    expect(createWithOwner).not.toHaveBeenCalled();
  });

  it("normalizes the slug (trim + lowercase) and name (trim) before creating", async () => {
    findBySlug.mockResolvedValue(null);
    const created = tenantRow({ slug: "ada-shop", name: "Ada" });
    createWithOwner.mockResolvedValue(created);

    await expect(
      tenantService.createStore(OWNER_ID, {
        name: "  Ada  ",
        slug: "  Ada-Shop  ",
      }),
    ).resolves.toBe(created);

    expect(findBySlug).toHaveBeenCalledWith("ada-shop");
    expect(createWithOwner).toHaveBeenCalledTimes(1);
    expect(createWithOwner).toHaveBeenCalledWith(
      { slug: "ada-shop", name: "Ada" },
      OWNER_ID,
    );
  });
});
