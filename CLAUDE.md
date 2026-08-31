# Commerce Platform — Agent Guide

Multi-tenant e-commerce platform (storefront + admin + pluggable fulfillment), built
end-to-end as a **production-grade portfolio project**. Read this fully before working.

Deep references: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
[`docs/DESIGN.md`](docs/DESIGN.md) · process: [`docs/milestones/README.md`](docs/milestones/README.md)

@AGENTS.md

## Golden rules (non-negotiable)

1. **Tenant isolation** — every business table has `tenantId`; every query is scoped by
   it. Never write a catalog/order query without a tenant scope.
2. **Layering** — UI/route → **service** → **repository** → Prisma. Pages & route
   handlers never call Prisma directly; repositories are the only place that touch it.
3. **Money = integer cents** (`priceCents`, `totalCents`). Never floats. Format only at
   the edge with `formatMoney`.
4. **Server-only stays server-only** — `src/server/**`, `src/lib/env.ts`,
   `src/lib/stripe.ts` must never reach the client bundle. Client reads config from
   `NEXT_PUBLIC_*` only.
5. **Secrets** — never commit `.env`, never log secrets, never put a secret in a
   `NEXT_PUBLIC_*` var.
6. **Migrations are forward-only** on shared branches — create with
   `pnpm db:migrate --name <change>`, review the generated SQL, never edit an applied one.

## Next.js 16 caveat

This is Next **16** (App Router, React 19, Turbopack) — APIs differ from older Next and
from most training data. When unsure, read `node_modules/next/dist/docs/` (see AGENTS.md)
before writing. Default to Server Components + Server Actions; add `"use client"` only
when a component truly needs interactivity/browser APIs.

## Stack

Next.js 16 · React 19 · TypeScript (strict) · Tailwind v4 · shadcn/ui · Prisma 6 +
PostgreSQL · Better Auth (email/password + RBAC) · Stripe · pnpm 11 · ESLint + Prettier ·
Vitest + Playwright (from Phase 2) · GitHub Actions.

## Commands

| Command                                        | Purpose                              |
| ---------------------------------------------- | ------------------------------------ |
| `pnpm dev`                                     | Dev server → http://localhost:3000   |
| `pnpm build` / `pnpm start`                    | Production build / serve             |
| `pnpm typecheck` · `pnpm lint` · `pnpm format` | Quality gates                        |
| `docker compose up -d`                         | Local Postgres (host port **55432**) |
| `pnpm db:migrate` · `db:seed` · `db:studio`    | Prisma migrate / seed / studio       |

> Local DB is on host port **55432** (5432 = native Postgres, 5433 = another container).
> `DATABASE_URL` uses `127.0.0.1:55432`.

## Directory map

```
src/
├─ app/
│  ├─ (storefront)/     # public store (Phase 1)
│  ├─ (admin)/admin/    # admin dashboard
│  └─ api/              # route handlers (auth, health, Stripe webhooks)
├─ components/ui/       # shadcn/ui primitives
├─ server/             # backend-only (never imported by client)
│  ├─ db.ts · auth/ · repositories/ · services/ · fulfillment/
├─ lib/                # env, stripe, utils (formatMoney, cn)
└─ config/             # roles, constants
```

## Conventions

- **TS strict**; no `any` (use `unknown` + narrow). Validate all external input with **zod**.
- **Naming** — files `kebab-case`; components `PascalCase`; vars/functions `camelCase`;
  Prisma models `PascalCase`, columns `camelCase`.
- **Imports** — use the `@/` alias. Never deep-import another feature's internals.
- **Errors** — services throw typed errors; the route/UI boundary handles them. Don't swallow.
- **Tests** — new service methods get a unit test (Phase 2+); checkout/payment get Playwright E2E.

## Design — avoid "AI-slop"

See [`docs/DESIGN.md`](docs/DESIGN.md). Core: restraint over decoration · a real type
scale · spacing on a 4px grid · one OKLCH accent · shadcn primitives (don't hand-roll) ·
lucide icons (no emoji) · accessible by default (labels, visible focus, AA contrast).

## Workflow

- Trunk is `main` (**protected**: PR + green CI required). Branch per task:
  `feat/…`, `fix/…`, `chore/…`, `docs/…`.
- **Daily loop** — `/task`: pick a GitHub issue → branch → plan → build → test →
  typecheck/lint → open PR linking the issue.
- **Milestones** — `/milestone-start` (research → plan → issues) → build →
  `/milestone-handoff` (verify → review → release → handoff). See `docs/milestones/README.md`.
- **DB changes** — `/db-change`.
- **Commits** — Conventional Commits; small and focused.

## Agents (`.claude/agents/`) — orchestrated by the main session (`/orchestrate`)

- **researcher** — investigates before building (code + web); read-only.
- **builder** — implements features.
- **tester** — writes/runs tests.
- **reviewer** — reviews diffs (correctness + conventions); reports, never edits.
- **scribe** — docs, handoff notes, changelog, memory.

## Don'ts

Don't call Prisma outside repositories · don't cross tenant boundaries · don't use floats
for money · don't import `src/server/**` into client components · don't commit secrets or
`.env` · don't edit applied migrations · don't add heavy dependencies without noting why ·
don't bypass the PR/CI flow on `main`.
