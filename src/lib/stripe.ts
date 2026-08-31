import "server-only";
import Stripe from "stripe";
import { env } from "@/lib/env";

let stripeSingleton: Stripe | null = null;

/**
 * Lazily-constructed Stripe client. Throws if Stripe is not configured so
 * checkout code fails loudly rather than silently no-op'ing.
 */
export function getStripe(): Stripe {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }
  stripeSingleton ??= new Stripe(key);
  return stripeSingleton;
}
