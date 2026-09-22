-- Story MOTIR-5871 · Subtask MOTIR-5954: what a `decision_confirmation` gate's
-- CONFIRM recorded about the decision's optional written record (ADR
-- `approval-gates.md` §1's MOTIR-5952 amendment, point 8) — the counting markdown
-- attachment's identity, or that there was none. Nullable, no backfill: null on
-- every other kind.
--
-- No trigger change: `trg_approval_gate_decided_immutable` compares the WHOLE row
-- (`to_jsonb(NEW)` against `to_jsonb(OLD)`), so a new column is covered the moment
-- it exists.
ALTER TABLE "approval_gate" ADD COLUMN "confirmed_record" JSONB;
