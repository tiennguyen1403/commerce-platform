import { z } from "zod";

/**
 * Checkout input shape, shared by the client form (UX validation) and the
 * Server Action (authoritative validation). Pure zod, no `server-only` import,
 * so both sides use the exact same rules. The cart itself is never sent from the
 * client — it's read from the cookie and re-priced server-side — so the only
 * field the shopper supplies here is their email.
 */
export const checkoutInputSchema = z.object({
  // 254 is the practical RFC-5321 ceiling for a full email address.
  email: z.email({ error: "Enter a valid email address." }).max(254),
});

export type CheckoutInput = z.infer<typeof checkoutInputSchema>;
