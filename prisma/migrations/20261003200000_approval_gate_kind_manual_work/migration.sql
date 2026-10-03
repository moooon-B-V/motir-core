-- MOTIR-7474: `manual_work` joins the approval-gate KIND enum
-- (`docs/decisions/manual-work-gate.md` §1). A run that reaches a manual card raises
-- one; the subject is the work item itself, so `subject_id` stays opaque and no
-- column changes here. Expand-only.
ALTER TYPE "approval_gate_kind" ADD VALUE IF NOT EXISTS 'manual_work';
