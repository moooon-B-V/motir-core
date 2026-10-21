-- MOTIR-8670: the two ways a `manual_work` gate is withdrawn when its card stops being
-- one a person can start (`docs/decisions/manual-work-gate.md` §6, amended 2026-10-15):
-- the card is no longer ready (Blocked, or an open `blocked_by`), and the card was
-- re-planned (Planning, or a plan approval rewrote it). Expand-only.
ALTER TYPE "approval_gate_supersede_cause" ADD VALUE IF NOT EXISTS 'not_ready';
ALTER TYPE "approval_gate_supersede_cause" ADD VALUE IF NOT EXISTS 'replanned';
