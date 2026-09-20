-- MOTIR-4950: `acceptance_result` joins the approval-gate KIND enum (ADR
-- `approval-gates.md` §1, the MOTIR-5787 amendment). A story's acceptance receipt
-- is decided through the one gate contract rather than its own decide path.
-- The gate row's `subject_id` stays opaque, so no column changes.
ALTER TYPE "approval_gate_kind" ADD VALUE IF NOT EXISTS 'acceptance_result';
