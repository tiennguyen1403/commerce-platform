// PreToolUse(Bash): block a few dangerous commands. Defense-in-depth for the CLAUDE.md rules.
import { readFileSync } from "node:fs";

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

let data = {};
try {
  data = JSON.parse(readStdin() || "{}");
} catch {
  process.exit(0);
}

const cmd = String(data?.tool_input?.command || "");

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

// 1. Never reset the database (destroys data). Use /db-change + forward-only migrations.
if (/\bprisma\s+migrate\s+reset\b/.test(cmd)) {
  deny(
    "Blocked: `prisma migrate reset` destroys the database. Use /db-change and forward-only migrations (CLAUDE.md).",
  );
}

// 2. No force-push (history rewrite). Use --force-with-lease on a feature branch instead.
if (
  /\bgit\s+push\b/.test(cmd) &&
  /(--force\b|\s-f\b)/.test(cmd) &&
  !/--force-with-lease/.test(cmd)
) {
  deny(
    "Blocked: force push. Use `--force-with-lease` on a feature branch; never rewrite `main` (CLAUDE.md).",
  );
}

// 3. Don't stage a real secret file. Only .env.example is tracked.
if (
  /\bgit\s+add\b/.test(cmd) &&
  /(^|[\s"'=/\\])\.env(?!\.example)(\b|['"]|$)/.test(cmd)
) {
  deny(
    "Blocked: staging a real `.env` (secrets never get committed — CLAUDE.md). Only `.env.example` is tracked.",
  );
}

process.exit(0);
