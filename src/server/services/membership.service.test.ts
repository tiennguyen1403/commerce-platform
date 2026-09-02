import { describe, it, expect, beforeEach, vi } from "vitest";
import { userRepository } from "@/server/repositories/user.repository";
import { membershipRepository } from "@/server/repositories/membership.repository";
import {
  membershipService,
  LastOwnerError,
  MemberNotFoundError,
  MembershipExistsError,
  UserNotFoundError,
} from "@/server/services/membership.service";

/**
 * Unit tests for the membership service, with both repositories mocked. The
 * focus is the business rules the service owns — add-by-email (must exist, not
 * already a member) and translating the repository's guarded-write outcome into
 * typed errors — not the repository's own Prisma/lock work.
 */

vi.mock("@/server/repositories/user.repository", () => ({
  userRepository: { findByEmail: vi.fn() },
}));

vi.mock("@/server/repositories/membership.repository", () => ({
  membershipRepository: {
    findForUser: vi.fn(),
    listForUser: vi.fn(),
    listByTenant: vi.fn(),
    countOwners: vi.fn(),
    create: vi.fn(),
    changeRole: vi.fn(),
    remove: vi.fn(),
  },
}));

const findByEmail = vi.mocked(userRepository.findByEmail);
const findForUser = vi.mocked(membershipRepository.findForUser);
const listForUser = vi.mocked(membershipRepository.listForUser);
const create = vi.mocked(membershipRepository.create);
const changeRole = vi.mocked(membershipRepository.changeRole);
const remove = vi.mocked(membershipRepository.remove);

const TENANT = "tenant_1";

type UserRow = NonNullable<
  Awaited<ReturnType<typeof userRepository.findByEmail>>
>;
type MembershipRow = NonNullable<
  Awaited<ReturnType<typeof membershipRepository.findForUser>>
>;

function userRow(o: { id?: string; email?: string } = {}): UserRow {
  return {
    id: o.id ?? "user_1",
    name: "Dana",
    email: o.email ?? "dana@example.com",
    emailVerified: true,
    image: null,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    updatedAt: new Date("2025-01-01T00:00:00.000Z"),
  };
}

function membershipRow(): MembershipRow {
  return {
    id: "mem_1",
    role: "STAFF",
    userId: "user_1",
    tenantId: TENANT,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
  };
}

beforeEach(() => {
  // Reset (not just clear) so a test that forgets to arm a mock can't inherit a
  // previous test's return value.
  vi.resetAllMocks();
});

describe("membershipService.addMemberByEmail", () => {
  it("throws UserNotFoundError when no account uses the email, without writing", async () => {
    findByEmail.mockResolvedValue(null);

    await expect(
      membershipService.addMemberByEmail(TENANT, "ghost@example.com", "STAFF"),
    ).rejects.toBeInstanceOf(UserNotFoundError);
    expect(create).not.toHaveBeenCalled();
  });

  it("normalizes the email (trim + lowercase) before the lookup", async () => {
    findByEmail.mockResolvedValue(userRow());
    findForUser.mockResolvedValue(null);
    create.mockResolvedValue(membershipRow());

    await membershipService.addMemberByEmail(
      TENANT,
      "  Dana@Example.COM ",
      "STAFF",
    );

    expect(findByEmail).toHaveBeenCalledWith("dana@example.com");
  });

  it("throws MembershipExistsError when the user is already a member", async () => {
    findByEmail.mockResolvedValue(userRow());
    findForUser.mockResolvedValue(membershipRow());

    await expect(
      membershipService.addMemberByEmail(TENANT, "dana@example.com", "ADMIN"),
    ).rejects.toBeInstanceOf(MembershipExistsError);
    expect(create).not.toHaveBeenCalled();
  });

  it("creates the membership when the account exists and isn't a member yet", async () => {
    findByEmail.mockResolvedValue(userRow({ id: "user_9" }));
    findForUser.mockResolvedValue(null);
    const created = membershipRow();
    create.mockResolvedValue(created);

    await expect(
      membershipService.addMemberByEmail(TENANT, "dana@example.com", "ADMIN"),
    ).resolves.toBe(created);
    expect(create).toHaveBeenCalledWith(TENANT, "user_9", "ADMIN");
  });
});

describe("membershipService.listStoresForUser", () => {
  it("delegates to the repository, scoped by the caller's user id", async () => {
    const rows: Awaited<ReturnType<typeof membershipRepository.listForUser>> = [
      { role: "OWNER", tenant: { slug: "demo", name: "Demo Store" } },
      { role: "STAFF", tenant: { slug: "aurora", name: "Aurora" } },
    ];
    listForUser.mockResolvedValue(rows);

    await expect(membershipService.listStoresForUser("user_1")).resolves.toBe(
      rows,
    );
    expect(listForUser).toHaveBeenCalledWith("user_1");
  });
});

describe("membershipService.changeRole", () => {
  it("throws LastOwnerError when the guard refuses (last owner)", async () => {
    changeRole.mockResolvedValue({ ok: false, reason: "last_owner" });

    await expect(
      membershipService.changeRole(TENANT, "user_1", "STAFF"),
    ).rejects.toBeInstanceOf(LastOwnerError);
  });

  it("throws MemberNotFoundError when the member is gone", async () => {
    changeRole.mockResolvedValue({ ok: false, reason: "not_found" });

    await expect(
      membershipService.changeRole(TENANT, "user_1", "STAFF"),
    ).rejects.toBeInstanceOf(MemberNotFoundError);
  });

  it("resolves and delegates to the repository on success", async () => {
    changeRole.mockResolvedValue({ ok: true });

    await expect(
      membershipService.changeRole(TENANT, "user_1", "ADMIN"),
    ).resolves.toBeUndefined();
    expect(changeRole).toHaveBeenCalledWith(TENANT, "user_1", "ADMIN");
  });
});

describe("membershipService.removeMember", () => {
  it("throws LastOwnerError when the guard refuses (last owner)", async () => {
    remove.mockResolvedValue({ ok: false, reason: "last_owner" });

    await expect(
      membershipService.removeMember(TENANT, "user_1"),
    ).rejects.toBeInstanceOf(LastOwnerError);
  });

  it("throws MemberNotFoundError when the member is gone", async () => {
    remove.mockResolvedValue({ ok: false, reason: "not_found" });

    await expect(
      membershipService.removeMember(TENANT, "user_1"),
    ).rejects.toBeInstanceOf(MemberNotFoundError);
  });

  it("resolves and delegates to the repository on success", async () => {
    remove.mockResolvedValue({ ok: true });

    await expect(
      membershipService.removeMember(TENANT, "user_1"),
    ).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledWith(TENANT, "user_1");
  });
});
