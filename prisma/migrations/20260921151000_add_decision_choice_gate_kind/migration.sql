-- MOTIR-5891: `decision_choice` joins the approval-gate KIND enum (ADR
-- `approval-gates.md` §1, the MOTIR-5887 amendment). A person picks one of the
-- options a `type: choice` work item states; the subject is a parsed section of
-- the work item's own body, so the gate row's `subject_id` stays opaque and no
-- column changes.
ALTER TYPE "approval_gate_kind" ADD VALUE IF NOT EXISTS 'decision_choice';
