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
