-- MOTIR-5954: `decision_confirmation` joins the approval-gate KIND enum (ADR
-- `approval-gates.md` §1, the MOTIR-5952 amendment). A person confirms — or
-- overturns — a decision a `type: decision` + `executor: human` work item holds;
-- the subject is the work item's own body, parsed, so the gate row's
-- `subject_id` stays opaque and no column changes here. Expand-only.
ALTER TYPE "approval_gate_kind" ADD VALUE IF NOT EXISTS 'decision_confirmation';
