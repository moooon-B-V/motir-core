-- THE DRIFT COUNT and the exact PAIR it was computed for (MOTIR-4644).
--
-- Three nullable columns, no backfill and no default: every existing row starts
-- with a null count, which is the answer "nobody has counted this pair yet" and
-- is already rendered by every consumer. A default of 0 would tell the whole
-- estate its graphs match its code on the evidence of a migration.
ALTER TABLE "github_repo"
  ADD COLUMN "commits_behind" INTEGER,
  ADD COLUMN "commits_behind_base_sha" TEXT,
  ADD COLUMN "commits_behind_head_sha" TEXT;
