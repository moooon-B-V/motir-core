-- Story MOTIR-6070 · Subtask MOTIR-6421: the VERDICT a Motir-pressed refusal of a
-- `design_result` gate carries — `revise` or `re_plan` (ADR `approval-gates.md` §10d,
-- amended by `design-refusal-verdict.md`). Expand-only: a new enum and a nullable
-- column, no backfill — every existing row reads NULL, which is the honest record
-- for a gate decided before the verdict existed.
--
-- No trigger change: `trg_approval_gate_decided_immutable` compares the WHOLE row
-- (`to_jsonb(NEW)` against `to_jsonb(OLD)`), so the new column is covered the moment
-- it exists, and the decide door writes it IN the deciding write.
CREATE TYPE "approval_gate_refusal_verdict" AS ENUM ('revise', 're_plan');

ALTER TABLE "approval_gate" ADD COLUMN "refusal_verdict" "approval_gate_refusal_verdict";
