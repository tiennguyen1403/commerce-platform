// PostToolUse(Edit|Write): format the edited file with Prettier. Advisory — never blocks.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".scss",
  ".md",
  ".mdx",
  ".yml",
  ".yaml",
  ".html",
]);

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

const file = data?.tool_response?.filePath || data?.tool_input?.file_path;
if (!file || !EXTS.has(path.extname(file).toLowerCase())) process.exit(0);

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const prettierBin = path.join(
  root,
  "node_modules",
  "prettier",
  "bin",
  "prettier.cjs",
);

spawnSync(
  process.execPath,
  [prettierBin, "--write", "--ignore-unknown", file],
  {
    cwd: root,
    stdio: "ignore",
  },
);

process.exit(0);
