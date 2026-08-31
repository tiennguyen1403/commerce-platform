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
