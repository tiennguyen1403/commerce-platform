import { describe, it, expect } from "vitest";
import { hasAtLeast, ROLES, type Role } from "@/config/roles";

describe("hasAtLeast", () => {
  // Full matrix: rows = actual role, cols = required role. OWNER > ADMIN > STAFF.
  const expected: Record<Role, Record<Role, boolean>> = {
    OWNER: { OWNER: true, ADMIN: true, STAFF: true },
    ADMIN: { OWNER: false, ADMIN: true, STAFF: true },
    STAFF: { OWNER: false, ADMIN: false, STAFF: true },
  };

  // Covers every pair, including reflexivity (equal roles satisfy) and
  // monotonicity (a higher role satisfies every lower requirement, never the
  // reverse).
  for (const role of Object.values(ROLES)) {
    for (const required of Object.values(ROLES)) {
      it(`${role} vs required ${required} → ${expected[role][required]}`, () => {
        expect(hasAtLeast(role, required)).toBe(expected[role][required]);
      });
    }
  }
});
