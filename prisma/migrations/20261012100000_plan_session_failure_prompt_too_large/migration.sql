-- MOTIR-8293 — a planning session can fail because its prompt overflowed the model.
--
-- motir-ai names that stop `walkStop.reasonCode: "prompt_too_large"` (MOTIR-8291,
-- motir-ai `docs/contract.md` §5). Core's closed vocabulary had no such member, so the
-- failure was recorded as `model_unavailable` and the overlay said the AI provider was
-- unavailable.
--
-- Forward-only: the statement adds an enum value before `internal` and touches no row.
-- Nothing in this file uses the new value, which is what lets Postgres (>= 12) run
-- `ADD VALUE` inside the migration's transaction.

ALTER TYPE "plan_session_failure_reason" ADD VALUE IF NOT EXISTS 'prompt_too_large' BEFORE 'internal';
