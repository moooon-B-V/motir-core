-- MOTIR-3981 — the run record learns what a run PRODUCED beyond code.
--
-- Two CARD-scoped members join `dispatch_event_kind`, per
-- `docs/decisions/run-findings-protocol.md` Q5: a run that files a bug or
-- submits a plan leaves a trace on the leg that produced it.
--
-- ⚠️ NO RLS CLAUSE HERE, AND THAT IS NOT AN OMISSION. RLS is a per-TABLE
-- policy; this migration creates no table and touches no row. `dispatch_run`,
-- `dispatch_run_card` and `dispatch_run_event` keep the workspace-scoped
-- policies `20260829120000_add_dispatch_run` gave them, and the two new values
-- are written through those same policies by the same service.
--
-- `ADD VALUE IF NOT EXISTS` is idempotent, so a re-applied migration is a
-- no-op rather than a failure. Postgres appends the value at the end of the
-- enum's sort order; nothing orders events by kind (every read orders by
-- `seq`), so the position carries no meaning.

ALTER TYPE "dispatch_event_kind" ADD VALUE IF NOT EXISTS 'bug_filed';
ALTER TYPE "dispatch_event_kind" ADD VALUE IF NOT EXISTS 'plan_submitted';
