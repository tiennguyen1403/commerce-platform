import "server-only";
import { z } from "zod";

// Server-side environment variables, validated once at startup.
// Client code must read `NEXT_PUBLIC_*` from `process.env` directly.
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(1),
  BETTER_AUTH_URL: z.string().min(1),
  // Required from Phase 1 checkout on: the app can't take payments without them.
  // The publishable key is deliberately absent — it's a `NEXT_PUBLIC_*` value the
  // client reads straight from `process.env`, never through this server-only file.
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  // Resend transactional email — required from M1 order-confirmation on. The
  // confirmation email is sent from the Stripe webhook's PENDING → PAID
  // transition. `EMAIL_FROM` is the verified sender in Resend's friendly-name
  // form `"Store <sender@domain>"` (a bare address also works). The Resend
  // client is built lazily (`src/server/services/email.service.ts`), so a
  // placeholder value satisfies a build that never actually sends.
  RESEND_API_KEY: z.string().min(1),
  EMAIL_FROM: z.string().min(1),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:", parsed.error.issues);
  throw new Error("Invalid environment variables");
}

export const env = parsed.data;
