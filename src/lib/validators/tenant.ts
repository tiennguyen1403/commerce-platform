import { z } from "zod";
import { RESERVED_SUBDOMAINS } from "@/config/constants";
import { SLUG_PATTERN } from "@/lib/validators/catalog";

/**
 * Store onboarding input shape, shared by the `/new` client form (UX
 * validation) and the Server Action (authoritative validation). Pure zod +
 * plain data: imported by a client component, so it must never pull in a
 * `server-only` module. The slug becomes the store's subdomain, so it reuses
 * the app-wide `SLUG_PATTERN` and the one `RESERVED_SUBDOMAINS` set that
 * subdomain resolution refuses — one rule, never duplicated.
 */

// A DNS label (subdomain) is at most 63 chars; 3 keeps a slug meaningful.
export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 63;

// Ceiling that keeps an obviously-bad name (a typo, a tampered payload) out of
// the DB without getting in a real owner's way — mirrors the catalog title cap.
const STORE_NAME_MAX = 160;

export const createStoreSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: "Store name is required." })
    .max(STORE_NAME_MAX, { error: "Store name is too long." }),
  // Normalized (trim + lowercase) before every check, so the length, shape, and
  // reserved rules all see the same value the store is created with.
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(SLUG_MIN_LENGTH, { error: "Use at least 3 characters." })
    .max(SLUG_MAX_LENGTH, { error: "Use at most 63 characters." })
    .regex(SLUG_PATTERN, {
      error: "Use lowercase letters, numbers, and hyphens only.",
    })
    .refine((slug) => !RESERVED_SUBDOMAINS.has(slug), {
      error: "That subdomain is reserved. Please choose another.",
    }),
});
export type CreateStoreInput = z.infer<typeof createStoreSchema>;

/** Field-keyed messages surfaced back to the create-store form. */
export type StoreFieldErrors = { name?: string; slug?: string };

/** Discriminated result the create-store Server Action returns to the client. */
export type StoreActionResult =
  | { ok: true; slug: string }
  | { ok: false; formError?: string; fieldErrors?: StoreFieldErrors };
