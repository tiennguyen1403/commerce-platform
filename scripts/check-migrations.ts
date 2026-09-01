/**
 * CI/local guard: refuse a Prisma migration that adds a `NOT NULL` column with
 * no `DEFAULT` to a table that may already hold rows — the pattern that breaks
 * `prisma migrate deploy` on non-empty databases (issue #38). Runs on the raw
 * SQL only: no database connection, no Prisma engine, no env required.
 *
 * Usage: `pnpm db:check-migrations` (wired into CI).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  findUnsafeColumnAdds,
  type UnsafeColumnAdd,
} from "./lib/check-migration-sql";

// Applied migrations are forward-only and MUST NOT be edited (CLAUDE.md golden
// rule 6). This one predates the guard; its documented corrective path lives in
// `docs/DATABASE.md` (issue #38). Grandfather it so CI stays green while the
// guard still blocks any *new* unsafe column add. Do not add to this list —
// give new NOT NULL columns a DEFAULT instead.
const GRANDFATHERED = new Set<string>(["20260831105827_account_issuer"]);

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const MIGRATIONS_DIR = join(scriptDir, "..", "prisma", "migrations");

function migrationSqlFiles(dir: string): { migration: string; file: string }[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((migration) => ({
      migration,
      file: join(dir, migration, "migration.sql"),
    }))
    .filter((entry) => existsSync(entry.file));
}

function main(): void {
  const files = migrationSqlFiles(MIGRATIONS_DIR);
  const problems: { migration: string; violation: UnsafeColumnAdd }[] = [];

  let scanned = 0;
  for (const { migration, file } of files) {
    if (GRANDFATHERED.has(migration)) continue;
    scanned++;
    const sql = readFileSync(file, "utf8");
    for (const violation of findUnsafeColumnAdds(sql)) {
      problems.push({ migration, violation });
    }
  }

  if (problems.length === 0) {
    const grandfathered = files.length - scanned;
    console.log(
      `migration-safety: OK — scanned ${scanned} migration(s)` +
        (grandfathered ? `, ${grandfathered} grandfathered` : "") +
        `; no NOT NULL column added without a DEFAULT.`,
    );
    return;
  }

  console.error("migration-safety: FAIL\n");
  for (const { migration, violation } of problems) {
    console.error(
      `  ${migration}/migration.sql: column "${violation.column}" on ` +
        `"${violation.table}" is added NOT NULL with no DEFAULT.`,
    );
  }
  console.error(
    "\nAdding a NOT NULL column with no DEFAULT to a table that may hold rows " +
      "makes\n`prisma migrate deploy` fail on non-empty databases. Give the " +
      "column a DEFAULT so\nPostgres backfills existing rows (drop it in a " +
      "follow-up migration if you don't\nwant it permanent). See docs/DATABASE.md.",
  );
  process.exitCode = 1;
}

main();
