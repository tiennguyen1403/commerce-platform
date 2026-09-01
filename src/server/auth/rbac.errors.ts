/**
 * RBAC error(s), thrown by the auth gate and mapped to a friendly message at the
 * Server Action boundary. Kept in a dependency-free module (no `server-only`) so
 * the gate that raises it and the actions that catch it can both import it
 * without pulling server internals into that shared type.
 */

/**
 * A signed-in member attempted a Server Action above their role. Thrown by
 * `assertRole` — render-time nav gating is UX only, so every privileged action
 * re-checks server-side and this is what a check failure raises.
 */
export class InsufficientRoleError extends Error {
  constructor() {
    super("You don't have permission to do that.");
    this.name = "InsufficientRoleError";
  }
}
