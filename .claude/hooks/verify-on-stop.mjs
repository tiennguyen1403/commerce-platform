// Stop: advisory typecheck + lint, but only when TS/TSX files changed. Async, never blocks.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

try {
  readFileSync(0, "utf8");
} catch {
  /* ignore stdin */
}

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function run(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, encoding: "utf8", shell: true });
}

// Only run when there are uncommitted TS/TSX changes.
const status = run("git", ["status", "--porcelain"]);
if (status.status !== 0) process.exit(0);

const tsChanged = String(status.stdout || "")
  .split("\n")
  .some((line) => /\.(ts|tsx)$/.test(line.trim()));
if (!tsChanged) process.exit(0);

const problems = [];
if (run("pnpm", ["-s", "typecheck"]).status !== 0) problems.push("typecheck");
if (run("pnpm", ["-s", "lint"]).status !== 0) problems.push("lint");

if (problems.length) {
  process.stdout.write(
    JSON.stringify({
      systemMessage: `⚠️ Advisory: ${problems.join(" + ")} failing on changed TS files — run \`pnpm ${problems.join("` and `pnpm ")}\` before opening a PR.`,
      suppressOutput: true,
    }),
  );
}

process.exit(0);
