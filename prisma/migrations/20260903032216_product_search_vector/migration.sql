-- Full-text search over the catalog (#105). A STORED generated column the
-- database maintains on every write of `title`/`description`, plus a GIN index
-- the search query rides. Hand-authored because a Prisma model can't express a
-- GENERATED / tsvector column: the schema declares it `Unsupported("tsvector")?`
-- only so `migrate` sees the column exists and never proposes to drop it.
--
-- `setweight(...,'A')` on the title and `'B'` on the description make a title
-- hit outrank a description-only hit under `ts_rank`. `coalesce(...,'')` keeps
-- the vector non-null when `description` is null. The `'english'` config matches
-- the `websearch_to_tsquery('english', …)` the repository queries with. Postgres
-- backfills the column for every existing row when the STORED column is added.
--
-- Migration-safety guard (docs/DATABASE.md): `pnpm db:check-migrations` exempts
-- GENERATED columns (they self-populate, so the add can't fail on a non-empty
-- table) and does not scan CREATE INDEX — this migration stays green.

-- AlterTable
ALTER TABLE "Product"
  ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("description", '')), 'B')
  ) STORED;

-- CreateIndex
CREATE INDEX "Product_searchVector_idx" ON "Product" USING GIN ("searchVector");
