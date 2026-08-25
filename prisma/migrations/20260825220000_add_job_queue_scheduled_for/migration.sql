-- MOTIR-3469 — THE PER-TICK KEY.
--
-- `job_queue` had no idempotency for a SCHEDULED enqueue. Its `(event_id,
-- job_id)` unique dedups event-triggered runs and, because a NULL never equals a
-- NULL in Postgres, deliberately does not constrain a cron run — whose
-- `event_id` is NULL. Two workers ticking the same minute therefore each
-- inserted a row and the job ran twice.
--
-- `scheduled_for` is the cron FIRE INSTANT the row stands for (never the moment
-- it was enqueued), and the unique below is the guarantee the scheduler leans on
-- instead of a check-then-insert. The same NULL rule that keeps the existing
-- constraint off scheduled runs keeps this one off event-triggered runs, which
-- carry a NULL `scheduled_for`.
--
-- A plain unique index, not a partial one: a hand-written PARTIAL index that
-- reuses another index's column list is the permanent-spurious-RENAME trap
-- CLAUDE.md § Migrations records, and `@@unique` expresses everything needed here.

-- AlterTable
ALTER TABLE "job_queue" ADD COLUMN     "scheduled_for" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "job_queue_job_id_scheduled_for_key" ON "job_queue"("job_id", "scheduled_for");
