-- Bug MOTIR-3683 — the job_run ledger tells the truth about a run that ended
-- badly, and about which engine ran it.
--
-- TWO defects, one cause. On the Inngest lane a CRON run derived its ledger
-- `event_id` two different ways: the run handler used the triggering event's id
-- (a real ULID), while `onFailure` read `event.data.event.id`, which Inngest
-- delivers as the EMPTY STRING for a scheduled trigger. `??` does not fall back
-- on `''`, so the terminal-failure path looked for a `running` row keyed on `''`,
-- found none, and CREATED a second row instead of flipping the first. The
-- original row stayed `running` for ever, and the failure landed on a row whose
-- `event_id` belongs to no lane.
--
-- This migration adds the two columns/values the fix needs and BACKFILLS the
-- historical rows. It changes no row's status: the 29 stranded `running` rows are
-- closed at RUNTIME by the reap job, so the disposition is observable on the
-- operator surface rather than buried in a migration nobody re-reads.

-- ── the lane, declared rather than inferred ─────────────────────────────────
CREATE TYPE "job_run_lane" AS ENUM ('inngest', 'engine');

ALTER TABLE "job_run" ADD COLUMN "lane" "job_run_lane";

-- BACKFILL, and the one place the id-format inference is still legitimate: it is
-- being used to RETIRE itself. Every cuid `event_id` was minted by the Postgres
-- engine's dispatcher (which only began writing on 2026-08-25); everything else —
-- ULID or empty — came from Inngest.
UPDATE "job_run"
SET "lane" = CASE
  WHEN "event_id" ~ '^c[a-z0-9]{24}$' THEN 'engine'::"job_run_lane"
  ELSE 'inngest'::"job_run_lane"
END
WHERE "lane" IS NULL;

-- NOT NULL with NO DEFAULT, deliberately: a default is how a row acquires a lane
-- nobody chose for it, which is the failure this column exists to end. Both
-- writers name their own lane, and a third writer that forgets fails to compile.
ALTER TABLE "job_run" ALTER COLUMN "lane" SET NOT NULL;

-- ── the terminal state for a run nothing is holding any more ────────────────
ALTER TYPE "job_run_status" ADD VALUE IF NOT EXISTS 'abandoned';

-- The reap's discovery read.
CREATE INDEX "job_run_status_started_at_idx" ON "job_run"("status", "started_at");
