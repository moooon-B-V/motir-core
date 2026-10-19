-- MOTIR-9065 — a planning session can fail because its plan went SILENT.
--
-- The abandoned-plan sweep records a failure on a `conversation` / `mcp` session when
-- the plan has written nothing past `PLAN_STALLED_AFTER_MS`. It recorded that through
-- the job read's error, so an unreachable motir-ai read as `model_unavailable` and a
-- person was told the AI provider was down while it was healthy. The sweep now records
-- its own verdict.
--
-- Forward-only: the statement adds an enum value before `internal` and touches no row.
-- Nothing in this file uses the new value, which is what lets Postgres (>= 12) run
-- `ADD VALUE` inside the migration's transaction.

ALTER TYPE "plan_session_failure_reason" ADD VALUE IF NOT EXISTS 'stalled' BEFORE 'internal';
