-- Story MOTIR-6526 · Subtask MOTIR-6528: a run's LIVENESS on its record
-- (`docs/decisions/run-death-keeps-work.md` §2). Expand-only: a nullable column and
-- an index, no backfill — every existing row reads NULL, which is exactly the
-- "opened by a CLI that never heartbeats" population `isRunAlive` keeps on the
-- 12-hour age reap.
ALTER TABLE "dispatch_run" ADD COLUMN "last_heartbeat_at" TIMESTAMP(3);

CREATE INDEX "dispatch_run_status_last_heartbeat_at_idx" ON "dispatch_run"("status", "last_heartbeat_at");
