-- The job worker's hot queue queries become index scans under FORCE RLS (bug MOTIR-8519).
--
-- `job_queue` is FORCE ROW LEVEL SECURITY and the runtime role (`motir_app`) does not
-- bypass it, so its policy runs as a SECURITY BARRIER. Postgres may only drive an index
-- scan with a qual that sits behind the barrier when the qual's functions are LEAKPROOF,
-- and the enum equality operator (`enum_eq`) is not. So `"state" = 'pending'` could
-- never seek `job_queue_state_run_at_idx`: every claim, backlog read and lease reclaim
-- was a full scan of the table — in production ~268k terminal rows read to find a few
-- pending ones, ~23 times every 30 s.
--
-- A PARTIAL index is usable where the composite one is not: the planner proves the
-- index's `WHERE` from the query's own qual, so it evaluates no function per row ahead
-- of the policy. Measured under a non-bypass role with FORCE RLS on (PostgreSQL 16):
-- the unchanged claim query moves from a Parallel Seq Scan discarding 200,003 rows to an
-- Index Scan discarding none. `"state"::text` would not do: an index on it is refused
-- (the enum-to-text cast is not IMMUTABLE).
--
-- ⚠️ THE COLUMN LISTS ARE DELIBERATE. Prisma cannot express a partial index and pairs
-- database indexes with `@@index` entries BY COLUMN LIST (`CLAUDE.md` § Migrations), so
-- these must never share a column list with an `@@index` on `JobQueueRun`. `(run_at)`
-- and `(lease_expires_at)` alone match none of them; the composite `(state, run_at)` /
-- `(state, lease_expires_at)` indexes stay, declared in the datamodel.

-- The CLAIM (`claimDueRuns`) and the BACKLOG read (`readDueBacklog`):
-- `WHERE state = 'pending' AND run_at <= now() ORDER BY run_at`.
CREATE INDEX "job_queue_pending_run_at_idx" ON "job_queue"("run_at") WHERE "state" = 'pending';

-- The LEASE-RECLAIM sweep (`reclaimExpiredLeases`):
-- `WHERE state = 'running' AND lease_expires_at < now()`. Renew and release
-- (`state = 'running' AND claimed_by = …`) walk this small index too.
CREATE INDEX "job_queue_running_lease_expires_at_idx" ON "job_queue"("lease_expires_at") WHERE "state" = 'running';
