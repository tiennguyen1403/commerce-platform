---
name: db-change
description: Safely change the Prisma schema and database — edit schema, migrate, review the generated SQL, update the seed, regenerate types. Use for any schema/model change.
---

# DB change

Safe Prisma workflow. Local DB is on host port **55432** (`docker compose up -d`).

1. **Edit** `prisma/schema.prisma`. Keep money as integer cents; add `tenantId` + a tenant index to any new business table; add relations / `@@unique` / `@@index` deliberately.
2. **Migrate (dev):** `pnpm db:migrate --name <concise_change>`. Never edit an already-applied migration.
3. **Review the generated SQL** in `prisma/migrations/<ts>_<name>/migration.sql` — watch for unintended drops/renames or missing indexes. Destructive changes need explicit intent.
4. **Regenerate** runs automatically; confirm `pnpm typecheck` passes with the new types.
5. **Update the seed** (`prisma/seed.ts`) and any affected repositories/services.
6. **Verify:** `pnpm db:seed` (idempotent) and `pnpm build`.

Production migrations apply via `pnpm db:deploy` in the deploy pipeline — never `migrate reset` against real data.
