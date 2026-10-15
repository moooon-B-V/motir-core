-- MOTIR-8569 — a planning session can fail because its motir-ai JOB failed.
--
-- motir-ai fails a job with `ai_job_failed` when its handler ran and refused — e.g. a
-- read-back from core it could not make, before any model was called. Core recorded that
-- as `model_unavailable`, so the overlay said the AI provider was unavailable while the
-- provider was healthy.
--
-- Forward-only: the statement adds an enum value before `internal` and touches no row.
-- Nothing in this file uses the new value, which is what lets Postgres (>= 12) run
-- `ADD VALUE` inside the migration's transaction.

ALTER TYPE "plan_session_failure_reason" ADD VALUE IF NOT EXISTS 'job_failed' BEFORE 'internal';
