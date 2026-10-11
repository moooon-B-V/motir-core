-- Story MOTIR-7905 · Subtask MOTIR-7913: a `planning_session` gate, like a
-- `plan_approval` one, belongs to NO work item — its subject (`subject_id`) is the
-- `PlanChangeSession.id`.
--
-- The BICONDITIONAL is REPLACED, keeping its name: a card-less kind ALWAYS has no
-- card and every other kind ALWAYS has one (`20260923200100_plan_approval_gate_cardless`
-- §11.1). Existing rows satisfy the wider check because a `plan_approval` row already
-- had a NULL card and nothing else did.
--
-- The one-awaiting-question-per-card-less-subject index
-- (`approval_gate_one_awaiting_per_cardless_subject`, `(subject_id, kind) WHERE
-- state = 'awaiting' AND work_item_id IS NULL`) is keyed on `work_item_id IS NULL`
-- and not on the kind, so it already covers the new kind and is NOT restated. The
-- decided-row immutability trigger names states, not kinds, so it needs no change.
ALTER TABLE "approval_gate" DROP CONSTRAINT "approval_gate_work_item_iff_not_plan";
ALTER TABLE "approval_gate"
  ADD CONSTRAINT "approval_gate_work_item_iff_not_plan"
  CHECK (("kind" IN ('plan_approval', 'planning_session')) = ("work_item_id" IS NULL));
