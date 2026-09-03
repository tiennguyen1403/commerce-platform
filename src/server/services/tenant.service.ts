import "server-only";
import { RESERVED_SUBDOMAINS } from "@/config/constants";
import { SLUG_PATTERN } from "@/lib/validators/catalog";
import { SLUG_MAX_LENGTH, SLUG_MIN_LENGTH } from "@/lib/validators/tenant";
import { tenantRepository } from "@/server/repositories/tenant.repository";
import {
  InvalidSlugError,
  ReservedSlugError,
  SlugTakenError,
} from "@/server/tenant.errors";

/**
 * Business logic for stores (tenants) — the self-serve onboarding write path.
 * Owns the slug rules (shape, length, reserved words) and the typed-error
 * vocabulary; the repository owns the Prisma work and the atomic tenant +
 * owner-membership transaction. Shape validation (zod) also runs at the Server
 * Action boundary — this layer re-checks the same rules so it's safe to call
 * directly, and stays free of Prisma. `ownerId` is always the server-derived
 * session user; a client-supplied id must never reach here.
 */

// Re-export so the Server Action boundary imports every tenant error from one
// place, without reaching into the error module directly.
export {
  InvalidSlugError,
  ReservedSlugError,
  SlugTakenError,
} from "@/server/tenant.errors";

export const tenantService = {
  /**
   * Create a store owned by `ownerId`. Normalizes and validates the slug, then
   * delegates the atomic tenant + OWNER-membership write to the repository. The
   * existence pre-check is the friendly path; the repo's P2002 mapping is the
   * race-safe backstop — both surface `SlugTakenError`.
   */
  async createStore(ownerId: string, input: { name: string; slug: string }) {
    const slug = input.slug.trim().toLowerCase();
    const name = input.name.trim();

    if (
      slug.length < SLUG_MIN_LENGTH ||
      slug.length > SLUG_MAX_LENGTH ||
      !SLUG_PATTERN.test(slug)
    ) {
      throw new InvalidSlugError();
    }
    if (RESERVED_SUBDOMAINS.has(slug)) throw new ReservedSlugError();

    // Friendly pre-check; the DB unique + repo mapping is the race-safe backstop.
    const existing = await tenantRepository.findBySlug(slug);
    if (existing) throw new SlugTakenError();

    return tenantRepository.createWithOwner({ slug, name }, ownerId);
  },
};
