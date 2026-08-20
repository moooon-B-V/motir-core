-- MOTIR-3189 — WHY a `declined` plan ended.
--
-- `declined` now covers three histories: a person rejected a finished plan
-- (`reviewed`), a person ended one that never finished generating
-- (`discarded`), and the abandoned-plan sweep terminated one whose producer was
-- provably gone (`abandoned`). All three were derivable from the null pattern
-- across `planned_at` / `decided_by_id` and none was recorded, so the review
-- surface rendered them identically.
--
-- A PRIVATE column, deliberately not a fourth `plan_status` member — see
-- `docs/decisions/agent-authored-plans.md` AMENDMENT 6 and the `Plan.decisionReason`
-- doc comment for why. NULLABLE with no backfill: every row written before this
-- migration genuinely has no recorded reason, and inventing one would be a
-- guess written into the record this column exists to make honest.
CREATE TYPE "plan_decision_reason" AS ENUM ('reviewed', 'discarded', 'abandoned');

ALTER TABLE "plan" ADD COLUMN "decision_reason" "plan_decision_reason";
