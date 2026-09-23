-- Story MOTIR-6012 · Subtask MOTIR-6032 (ADR `approval-gates.md` §11.1–§11.2,
-- §11.4): a gate row may belong to NO work item — the `plan_approval` kind, and
-- only that kind. Its subject (`subject_id`, the `Plan.id`) says what it is
-- about. Expand-only: an old build keeps writing rows that carry a card and are
-- never `plan_approval`, which satisfies every constraint below, and the shipped
-- unique index is untouched.
--
-- SHAPES CONSIDERED AND REJECTED (§11.2):
--   · a `plan_id` column, keyed with `COALESCE(work_item_id, plan_id)` — a
--     second polymorphic owner beside `subject_id`, holding the same value, and
--     an index keying two id spaces in one column;
--   · re-creating `approval_gate_one_awaiting_per_subject` `NULLS NOT DISTINCT`
--     (this project runs Postgres 16 — `docker-compose.yml` pins
--     `pgvector/pgvector:pg16` — so it is available) — it rebuilds the one index
--     every kind relies on to key a question only this kind asks.
--   · a foreign key to `plan` — not owed: a plan is never deleted on its own,
--     only with its project, whose cascade already takes the gate; and a subject
--     that vanished is the shipped `resolveSubject → null` answer for every kind.
--
-- RLS: `approval_gate_active_workspace` reads `workspace_id` alone, which a
-- card-less row still carries, so the policy needs NO change and is not restated.

-- AlterTable
ALTER TABLE "approval_gate" ALTER COLUMN "work_item_id" DROP NOT NULL;

-- The BICONDITIONAL (§11.1): a plan gate ALWAYS has no card, and every other kind
-- ALWAYS has one. Relaxing the column alone would let any kind lose its card, and
-- a card-less design gate is a question nobody can reach.
ALTER TABLE "approval_gate"
  ADD CONSTRAINT "approval_gate_work_item_iff_not_plan"
  CHECK (("kind" = 'plan_approval') = ("work_item_id" IS NULL));

-- CreateIndex — the card-less lookup (`@@index([kind, subjectId, state])`).
CREATE INDEX "approval_gate_kind_subject_id_state_idx" ON "approval_gate"("kind", "subject_id", "state");

-- ONE awaiting question per card-less subject. The shipped
-- `approval_gate_one_awaiting_per_subject` keys `(work_item_id, kind,
-- subject_id)`, and Postgres treats every NULL `work_item_id` as distinct, so it
-- admits any number of awaiting plan gates for one plan. This index covers the
-- card-less rows alone.
--
-- ⚠️ Its column list `(subject_id, kind)` is deliberately NOT the list of any
-- `@@index` on the model (the card-less lookup above leads with `kind` and adds
-- `state`): Prisma's differ pairs indexes BY COLUMN LIST and cannot express a
-- WHERE clause, so a collision would surface as a permanent spurious rename.
CREATE UNIQUE INDEX "approval_gate_one_awaiting_per_cardless_subject"
  ON "approval_gate" ("subject_id", "kind")
  WHERE "state" = 'awaiting' AND "work_item_id" IS NULL;

-- A `declined` gate is a DECISION (§11.4), so the decided-row immutability
-- trigger holds it exactly as it holds the other decided states. The function's
-- predicate ENUMERATES them, so a new one is not covered until it is named here.
-- Everything else is the `20260922000300_approval_gate_decided_immutable_overturned`
-- body verbatim.
CREATE OR REPLACE FUNCTION enforce_approval_gate_decided_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."state" IN ('approved', 'changes_requested', 'overturned', 'declined') THEN
    -- A `SetNull` referential action on either user FK, changing nothing else.
    IF (to_jsonb(NEW) - 'decided_by_id' - 'routed_to_id')
         = (to_jsonb(OLD) - 'decided_by_id' - 'routed_to_id')
       AND (NEW."decided_by_id" IS NULL
            OR NEW."decided_by_id" IS NOT DISTINCT FROM OLD."decided_by_id")
       AND (NEW."routed_to_id" IS NULL
            OR NEW."routed_to_id" IS NOT DISTINCT FROM OLD."routed_to_id")
    THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'AG_DECIDED_IMMUTABLE: approval gate % was decided (%) at % and cannot be updated',
      OLD."id", OLD."state", OLD."decided_at"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
