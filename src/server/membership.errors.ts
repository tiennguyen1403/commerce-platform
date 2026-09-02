/**
 * Typed membership errors, thrown by the service/repository and mapped to
 * field- or form-level messages at the Server Action boundary. Kept in a
 * dependency-free module (mirrors `catalog.errors.ts`) so both the repository
 * (which raises `MembershipExistsError` from a Prisma unique failure) and the
 * service (which raises the rest from business rules) can import them without
 * either layer depending on the other.
 */

/**
 * No account uses the given email. Members are added by email and must already
 * exist — an admin request must never create the login itself (calling
 * `auth.api.signUpEmail` would overwrite the owner's session via `nextCookies`).
 */
export class UserNotFoundError extends Error {
  constructor() {
    super(
      "No account uses that email. Ask them to sign up first, then add them.",
    );
    this.name = "UserNotFoundError";
  }
}

/** The user is already a member of this tenant. */
export class MembershipExistsError extends Error {
  constructor() {
    super("That person is already a member.");
    this.name = "MembershipExistsError";
  }
}

/** The targeted membership no longer exists (e.g. removed in a concurrent tab). */
export class MemberNotFoundError extends Error {
  constructor() {
    super("That member no longer exists.");
    this.name = "MemberNotFoundError";
  }
}

/**
 * Refused a change that would leave the tenant with no OWNER. A store must keep
 * at least one owner, so demoting or removing the last one is rejected.
 */
export class LastOwnerError extends Error {
  constructor() {
    super("A store must keep at least one owner.");
    this.name = "LastOwnerError";
  }
}
