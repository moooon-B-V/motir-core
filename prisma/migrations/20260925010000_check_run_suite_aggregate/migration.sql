-- MOTIR-6274: a check row can say it is a SUITE'S OWN ROLL-UP rather than a check.
--
-- GitHub's `check_suite` event is recorded as a row named by the App slug, and
-- every GitHub Actions workflow is the SAME App — so `ci.yml`, `codeql.yml` and
-- `acceptance.yml` each write a row named `github-actions` under their own suite.
-- `liveCheckRows` reconstructs "same workflow" from a SHARED NAME, so that one row
-- made every Actions suite at a commit look like a re-run of every other one, and
-- the newest retired the rest wholesale. The row is not a check and says nothing
-- about which workflow a suite is; this column lets the fold leave it out of that
-- test without guessing from its name.
--
-- Additive with a default, so the ordinary deploy order (migrate, then take
-- traffic) is safe: the still-serving build neither reads nor names it.
ALTER TABLE "github_check_run" ADD COLUMN "suite_aggregate" BOOLEAN NOT NULL DEFAULT false;

-- Backfill the rows already written by that path. The GitHub `check_suite` parse
-- is the only writer of a row named `github-actions` (an Actions CHECK RUN is
-- named after its job), and the name is only trusted here, once, for rows that
-- also carry a suite id — the column is what every later write sets explicitly.
-- Other Apps' roll-ups written before this migration keep their old reading until
-- their commit is re-recorded; the Actions one is the collision this card is about.
UPDATE "github_check_run"
SET "suite_aggregate" = true
WHERE "check_name" = 'github-actions' AND "check_suite_id" <> '';
