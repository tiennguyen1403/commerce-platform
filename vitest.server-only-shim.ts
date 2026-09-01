// Empty stand-in for the `server-only` package under Vitest.
//
// `server-only` resolves to a module that throws on import unless the bundler
// sets the `"react-server"` export condition (Next does; Vitest never does), so
// any test that transitively imports a server-only file (e.g. `@/lib/env`) would
// crash at import time. `vitest.config.mts` aliases `server-only` to this no-op so
// those modules load. The real client/server boundary is still enforced at build
// time by Next — this only relaxes it for the test runner.
export {};
