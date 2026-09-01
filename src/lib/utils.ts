import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge conditional class names and de-duplicate Tailwind utilities. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format integer minor units (cents) as a localized currency string. */
export function formatMoney(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

/** Format a date for admin display — a medium date, optionally with a short
 *  time (e.g. order detail). Rendered server-side only (Server Components), so
 *  the fixed `en-US` locale is deterministic with no hydration mismatch. */
export function formatDate(value: Date | string, withTime = false) {
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat(
    "en-US",
    withTime
      ? // `timeZoneName` labels the zone (the runtime's — UTC in prod, local in
        // dev) so an operator never misreads a bare wall-clock time.
        { dateStyle: "medium", timeStyle: "short", timeZoneName: "short" }
      : { dateStyle: "medium" },
  ).format(date);
}

/**
 * Derive a URL-safe slug from arbitrary text: lowercase, decompose accents via
 * NFKD, then collapse every run of non-alphanumeric characters (the leftover
 * combining marks included) into single hyphens. Used to suggest a product slug
 * from its title; the value stays user-editable.
 */
export function slugify(input: string) {
  return input
    .normalize("NFKD")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
