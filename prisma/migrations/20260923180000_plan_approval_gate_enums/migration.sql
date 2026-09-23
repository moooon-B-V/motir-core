-- Story MOTIR-6012 · Subtask MOTIR-6032 (ADR `approval-gates.md` §11.1, §11.4,
-- §11.6, §11.7): the enum members the PLAN-APPROVAL kind needs. Expand-only,
-- the one-line shape `20260922000000_add_decision_confirmation_gate_kind` uses.
--
-- ⚠️ In a migration of their OWN, ahead of `…_plan_approval_gate_cardless`:
-- Postgres refuses to USE a value added by `ALTER TYPE … ADD VALUE` inside the
-- transaction that added it ("unsafe use of new value"), and the next
-- migration's CHECK constraint names `'plan_approval'`.
--
-- Nothing writes any of these yet: `plan_approval` is UNREGISTERED
-- (`lib/approvalGates/registry.ts`) until MOTIR-6035.
ALTER TYPE "approval_gate_kind" ADD VALUE IF NOT EXISTS 'plan_approval';
ALTER TYPE "approval_gate_state" ADD VALUE IF NOT EXISTS 'declined';
ALTER TYPE "approval_gate_supersede_cause" ADD VALUE IF NOT EXISTS 'plan_stale';
ALTER TYPE "approval_gate_supersede_cause" ADD VALUE IF NOT EXISTS 'plan_discarded';
ALTER TYPE "approval_gate_authority" ADD VALUE IF NOT EXISTS 'plan_permission';
