export const ROLES = {
  OWNER: "OWNER",
  ADMIN: "ADMIN",
  STAFF: "STAFF",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

// Higher rank = more privilege.
const ROLE_RANK: Record<Role, number> = {
  OWNER: 3,
  ADMIN: 2,
  STAFF: 1,
};

/** True if `role` has at least the privilege level of `required`. */
export function hasAtLeast(role: Role, required: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}
