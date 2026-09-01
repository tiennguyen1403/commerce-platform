import { resolve } from "node:path";
import { defineConfig, configDefaults } from "vitest/config";

// Absolute path to the `server-only` stand-in (see that file for why). `cwd()` is
// the repo root under `pnpm test`/CI, and is robust to how Vitest loads this
// config (unlike `import.meta.dirname`, which can point at a bundled temp file).
const serverOnlyShim = resolve(process.cwd(), "vitest.server-only-shim.ts");

export default defineConfig({
  resolve: {
    // Resolve the app's `@/*` → `src/*` alias straight from tsconfig, so test and
    // source files resolve `@/…` the same way the app does (native Vite 8 feature
    // — no plugin needed).
    tsconfigPaths: true,
    alias: {
      // `server-only` throws on import outside an RSC bundle; swap it for a no-op.
      "server-only": serverOnlyShim,
    },
  },
  test: {
    // Seed the dummy env (mirrors ci.yml) before any test module — and thus
    // `@/lib/env` — is imported.
    setupFiles: ["./vitest.setup.ts"],
    // The dom/integration projects have no tests yet; don't fail the run over it.
    passWithNoTests: true,
    // Three environments, split by filename so a file's needs are obvious:
    //   *.test.ts             → unit        (node, zero infra)
    //   *.test.tsx            → dom         (jsdom, sync client components)
    //   *.integration.test.ts → integration (node, real Postgres — later milestone)
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
          // `*.integration.test.ts` also ends in `.test.ts`; keep it out of unit.
          exclude: [...configDefaults.exclude, "src/**/*.integration.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["src/**/*.integration.test.ts"],
        },
      },
    ],
  },
});
