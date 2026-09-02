/**
 * Typed tenant (store) errors, thrown by the service/repository and mapped to
 * field- or form-level messages at the Server Action boundary. Kept in a
 * dependency-free module (mirrors `membership.errors.ts` / `catalog.errors.ts`)
 * so both the repository (which raises `SlugTakenError` from a Prisma unique
 * failure) and the service (which raises the slug-rule errors) can import them
 * without either layer depending on the other.
 */

/**
 * A store already uses that subdomain. `Tenant.slug` is globally unique, so a
 * slug maps to at most one store; a duplicate is refused rather than shadowing
 * an existing one.
 */
export class SlugTakenError extends Error {
  constructor() {
    super("That subdomain is already taken. Try another.");
    this.name = "SlugTakenError";
  }
}

/**
 * The slug is platform infrastructure (`www`, `admin`, `api`, …), not a store.
 * Reserved words are refused so a tenant can never shadow a platform host — the
 * one `RESERVED_SUBDOMAINS` set, shared with subdomain resolution.
 */
export class ReservedSlugError extends Error {
  constructor() {
    super("That subdomain is reserved. Please choose another.");
    this.name = "ReservedSlugError";
  }
}

/** The slug is the wrong shape or length for a subdomain (see the slug rules). */
export class InvalidSlugError extends Error {
  constructor() {
    super("Use 3–63 lowercase letters, numbers, and hyphens.");
    this.name = "InvalidSlugError";
  }
}
