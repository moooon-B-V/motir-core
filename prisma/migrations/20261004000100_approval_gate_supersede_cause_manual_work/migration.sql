-- MOTIR-7474: the two ways a `manual_work` gate is withdrawn that no shipped cause
-- names (`docs/decisions/manual-work-gate.md` §6): the card stopped being manual, and
-- the card reached a done status by a write nobody decided. Expand-only.
ALTER TYPE "approval_gate_supersede_cause" ADD VALUE IF NOT EXISTS 'no_longer_manual';
ALTER TYPE "approval_gate_supersede_cause" ADD VALUE IF NOT EXISTS 'closed_without_decision';
