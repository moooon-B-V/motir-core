-- MOTIR-6946 — the approve-to-merge question rides on the GREEN set, so a set that leaves
-- green WITHOUT going red — a check at the asked-about commits is `pending` again — must
-- retire it too (`docs/decisions/approval-gates.md` §8's amendment, decision 2).
--
-- `approval_gate_supersede_cause` is a CLOSED vocabulary with one value per writing path and
-- no value meaning "unsaid" (§6b, MOTIR-5658), so the new withdrawal path owes a new value.
-- `ci_failed` would have been the nearest lie: nothing failed, the verdict is not in yet.
ALTER TYPE "approval_gate_supersede_cause" ADD VALUE IF NOT EXISTS 'ci_rerunning';
