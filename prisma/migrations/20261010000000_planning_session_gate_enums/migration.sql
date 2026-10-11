-- Story MOTIR-7905 · Subtask MOTIR-7913 (ADR `approval-gates.md` §1's MOTIR-7906
-- amendment): the enum members the PLANNING-SESSION kind needs. Expand-only, the
-- shape `20260923200000_plan_approval_gate_enums` uses.
--
-- ⚠️ In a migration of their OWN, ahead of `…_planning_session_gate_cardless`:
-- Postgres refuses to USE a value added by `ALTER TYPE … ADD VALUE` inside the
-- transaction that added it ("unsafe use of new value"), and the next migration's
-- CHECK constraint names `'planning_session'`.
ALTER TYPE "approval_gate_kind" ADD VALUE IF NOT EXISTS 'planning_session';
ALTER TYPE "approval_gate_supersede_cause" ADD VALUE IF NOT EXISTS 'answered';
ALTER TYPE "approval_gate_supersede_cause" ADD VALUE IF NOT EXISTS 'session_ended';
