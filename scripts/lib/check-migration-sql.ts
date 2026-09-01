/**
 * Static safety check for Prisma migration SQL — no database, no Prisma engine.
 *
 * Adding a `NOT NULL` column with no `DEFAULT` to a table that already holds
 * rows makes `prisma migrate deploy` fail on any non-empty environment
 * (Postgres: `column "…" contains null values`). A *fresh* deploy passes
 * because the table is still empty when the migration runs, so the fault only
 * surfaces later, in staging/production. See `docs/DATABASE.md` (issue #38).
 *
 * The convention this guards: a new `NOT NULL` column on a table that may hold
 * rows must ship with a `DEFAULT` so Postgres backfills existing rows (drop the
 * default in a follow-up migration if you don't want it permanent).
 */

/** A `NOT NULL` column added with no `DEFAULT` — the pattern we refuse. */
export type UnsafeColumnAdd = {
  table: string;
  column: string;
};

/** Drop `-- line comments` so keyword scanning can't trip over commented SQL. */
function stripLineComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

// Keywords that begin a new `ALTER TABLE` action clause. Used to bound one
// `ADD COLUMN` definition so a *sibling* clause's DEFAULT can't mask a column
// that is itself missing one (multi-action `ALTER TABLE … , …` statements).
// `RENAME` is anchored to its object keyword (`RENAME COLUMN|CONSTRAINT|TO`) so
// it can't substring-match inside a column literally named `"rename"`.
const ACTION_BOUNDARY =
  /\b(?:ADD\s+COLUMN|ADD\s+CONSTRAINT|ADD\s+PRIMARY\s+KEY|ADD\s+FOREIGN\s+KEY|ALTER\s+COLUMN|DROP\s+COLUMN|DROP\s+CONSTRAINT|DROP\s+DEFAULT|RENAME\s+(?:COLUMN|CONSTRAINT|TO))\b/gi;

/**
 * Parse migration SQL and return every `ADD COLUMN … NOT NULL` that ships
 * without a `DEFAULT` and isn't auto-populated (identity/serial). Columns added
 * to a table that is *created in the same migration* are ignored: that table is
 * empty, so the add can never fail.
 */
export function findUnsafeColumnAdds(sql: string): UnsafeColumnAdd[] {
  const clean = stripLineComments(sql);
  const violations: UnsafeColumnAdd[] = [];

  // Tables created in this same migration are empty → an ADD COLUMN against
  // them can't fail. Collect them first to suppress false positives.
  const createdTables = new Set<string>();
  const createRe = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([\w$]+)"?/gi;
  let created: RegExpExecArray | null;
  while ((created = createRe.exec(clean)) !== null) {
    createdTables.add(created[1]);
  }

  for (const statement of clean.split(";")) {
    const alter = /^\s*ALTER\s+TABLE\s+(?:ONLY\s+)?"?([\w$]+)"?/i.exec(
      statement,
    );
    if (!alter) continue;
    const table = alter[1];
    if (createdTables.has(table)) continue;

    // Slice each action clause up to the next boundary (or end of statement).
    const starts: number[] = [];
    ACTION_BOUNDARY.lastIndex = 0;
    let boundary: RegExpExecArray | null;
    while ((boundary = ACTION_BOUNDARY.exec(statement)) !== null) {
      starts.push(boundary.index);
    }

    for (let i = 0; i < starts.length; i++) {
      const end = i + 1 < starts.length ? starts[i + 1] : statement.length;
      const clause = statement.slice(starts[i], end);
      if (!/^\s*ADD\s+COLUMN\b/i.test(clause)) continue;
      if (!/\bNOT\s+NULL\b/i.test(clause)) continue;
      // A real default backfills existing rows; `DEFAULT NULL` does not, so it
      // stays a violation.
      if (/\bDEFAULT\s+(?!NULL\b)/i.test(clause)) continue;
      // Identity/serial columns generate their own value for every row.
      if (/\bGENERATED\b|\b(?:BIG|SMALL)?SERIAL\b/i.test(clause)) continue;

      const name = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([\w$]+)"?/i.exec(
        clause,
      );
      violations.push({ table, column: name ? name[1] : "(unknown)" });
    }
  }

  return violations;
}
