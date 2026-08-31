# Commerce Platform

A production-grade, **multi-tenant e-commerce platform** — storefront, admin, and
a pluggable fulfillment engine — built end-to-end. Each store is an isolated
tenant, so the same codebase can run one shop or many.

> Status: **Phase 0 — foundations.** Storefront, checkout, and admin land in
> Phases 1–2 (see [Roadmap](#roadmap)).

## Tech stack

| Layer       | Choice                                                        |
| ----------- | ------------------------------------------------------------- |
| Framework   | Next.js 16 (App Router) + React 19 + TypeScript               |
| Styling     | Tailwind CSS v4                                               |
| Database    | PostgreSQL + Prisma ORM                                       |
| Auth        | Better Auth (email/password, RBAC)                            |
| Payments    | Stripe (Payment Intents + webhooks)                           |
| Fulfillment | Provider interface (Printful/POD adapter)                     |
| Tooling     | ESLint, Prettier, Vitest/Playwright (planned), GitHub Actions |

## Architecture

```
src/
├─ app/
│  ├─ (storefront)/        # public store routes (Phase 1)
│  ├─ (admin)/admin/       # admin dashboard
│  └─ api/                 # route handlers (auth, health, Stripe webhooks)
├─ components/ui/          # UI primitives
├─ server/                 # backend-only (never imported by client)
│  ├─ db.ts                # Prisma singleton
│  ├─ auth/                # Better Auth config + client
│  ├─ repositories/        # data access — always scoped by tenantId
│  ├─ services/            # business logic
│  └─ fulfillment/         # provider interface + adapters
├─ lib/                    # env, stripe, utils
└─ config/                 # roles, constants
```

**Rules of the road**

- Every business table carries `tenantId`; repositories always scope by it.
- Routes/pages call **services**, services call **repositories**, repositories
  are the only place that touches Prisma.
- Money is stored as integer cents.

## Getting started

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment
cp .env.example .env        # then edit values

# 3. Start Postgres (Docker)
docker compose up -d

# 4. Run migrations + seed demo data
pnpm db:migrate
pnpm db:seed

# 5. Run the app
pnpm dev                    # http://localhost:3000
```

Health check: <http://localhost:3000/api/health>

## Scripts

| Script            | Description                  |
| ----------------- | ---------------------------- |
| `pnpm dev`        | Start the dev server         |
| `pnpm build`      | Production build             |
| `pnpm lint`       | ESLint                       |
| `pnpm typecheck`  | TypeScript, no emit          |
| `pnpm format`     | Prettier write               |
| `pnpm db:migrate` | Create/apply a dev migration |
| `pnpm db:studio`  | Open Prisma Studio           |
| `pnpm db:seed`    | Seed demo tenant + products  |

## Roadmap

- **Phase 0 — Foundations** ✅ repo, CI, DB, auth skeleton, deployable.
- **Phase 1 — Commerce slice:** catalog, storefront, cart, Stripe checkout, order
  confirmation, basic admin.
- **Phase 2 — Production-grade:** RBAC, analytics dashboard, inventory, webhook
  order state machine, search, tests, observability.
- **Phase 3 — Platform:** true multi-tenant (subdomains, theming, onboarding,
  Stripe Connect).
- **Phase 4 — Fulfillment:** Printful/POD integration, tracking sync, polish.
