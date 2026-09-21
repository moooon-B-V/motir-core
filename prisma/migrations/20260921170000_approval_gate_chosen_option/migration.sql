-- Story MOTIR-4914 · Subtask MOTIR-5893: what a `decision_choice` gate's decision
-- PICKED, stamped on the deciding write (ADR `approval-gates.md` §1's MOTIR-5887
-- amendment, point 7). Nullable, no backfill: null on every other kind.
--
-- No trigger change: `trg_approval_gate_decided_immutable` compares the WHOLE row
-- (`to_jsonb(NEW)` against `to_jsonb(OLD)`), so a new column is covered the moment
-- it exists.
ALTER TABLE "approval_gate" ADD COLUMN "chosen_option" JSONB;
