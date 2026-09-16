-- MOTIR-5464 — a REPAIR is a dispatch run, so `fix` joins `dispatch_command`.
--
-- `POST /api/v1/work-items/{key}/repair` claims an `implemented` card's red pull
-- requests for ONE fixing agent at a time, and the claim is an open dispatch run
-- whose command is `fix` (Story MOTIR-5460). The run's open state IS the lock, so
-- the card's status is never written: a red build already means `implemented`.
--
-- ⚠️ NO RLS CLAUSE HERE, AND THAT IS NOT AN OMISSION. RLS is a per-TABLE policy;
-- this migration creates no table and touches no row. `dispatch_run` keeps the
-- workspace-scoped policy `20260829120000_add_dispatch_run` gave it.
--
-- `ADD VALUE IF NOT EXISTS` is idempotent, so a re-applied migration is a no-op.
-- Postgres appends the value at the end of the enum's sort order; nothing orders
-- runs by command, so the position carries no meaning.

ALTER TYPE "dispatch_command" ADD VALUE IF NOT EXISTS 'fix';
