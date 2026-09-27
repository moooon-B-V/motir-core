-- MOTIR-6595 — a merge-queue FAILURE is CAN'T-LAND (`docs/decisions/approval-gates.md` §4
-- FIFTH AMENDMENT), so a gate the OLD rule re-asked from one is withdrawn by the convergence.
--
-- `approval_gate_supersede_cause` is a CLOSED vocabulary with one value per writing path and
-- no value meaning "unsaid" (§6b, MOTIR-5658), so the convergence owes a value of its own.
-- `ci_failed` would have been the nearest lie: that one is the pull request's OWN build, and
-- this is the queue's merge group.
ALTER TYPE "approval_gate_supersede_cause" ADD VALUE IF NOT EXISTS 'queue_failed';
