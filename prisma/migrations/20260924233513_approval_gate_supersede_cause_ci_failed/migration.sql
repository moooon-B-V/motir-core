-- MOTIR-6271 — the approve-to-merge question rides on the GREEN set, so the build going
-- red must retire it (`docs/decisions/approval-gates.md` §8's amendment, decision 2).
--
-- `approval_gate_supersede_cause` is a CLOSED vocabulary with one value per writing path and
-- no value meaning "unsaid" (§6b, MOTIR-5658), so the new withdrawal path owes a new value
-- rather than borrowing one. `head_moved` would have been the nearest lie: nothing moved.
ALTER TYPE "approval_gate_supersede_cause" ADD VALUE IF NOT EXISTS 'ci_failed';
