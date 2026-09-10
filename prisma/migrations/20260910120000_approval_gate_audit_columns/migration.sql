-- The approval gate's AUDIT columns, and the guard that makes them evidence
-- (Story MOTIR-4778 · Subtask MOTIR-4912; ADR docs/decisions/approval-gates.md
-- §6a, with §6b's MOTIR-4911 amendment for `decision_source: github`).
--
-- MOTIR-4788 landed the gate's WORKFLOW half — the subject, the kind, the state,
-- who decided and when, the note. This is the AUDIT half: the row is read months
-- later by someone who was not there, so it has to answer what was approved, by
-- whom (even after they leave), who was asked, under what permission, through
-- which surface, and what it caused. In ONE atomic step (migration-by-concern,
-- PRODECT_FINDINGS #20) so there is never a window where a column exists without
-- the guard that protects it:
--   1. the `approval_gate_authority` + `approval_gate_decision_source` enums;
--   2. six nullable columns + the `routed_to_id` FK;
--   3. the BEFORE UPDATE trigger that makes a DECIDED gate immutable.
--
-- ⚠️ PURELY ADDITIVE, and that is a property of the column list rather than a
-- claim about it: every column is NULLABLE with no default and no backfill, so
-- an existing row is valid the instant this applies and no row is rewritten. The
-- table's RLS policy is `FOR ALL` over `workspace_id` and is untouched — a new
-- column on a policed table needs no policy of its own.
--
-- ⚠️ The trigger is installed in the SAME migration as the columns deliberately.
-- Split across two, the window between them is one in which a decided row is
-- editable, and an audit table that was briefly editable is an audit table whose
-- history nobody can vouch for.
--
-- No index is added. Every audit column is read as part of a row already located
-- by `id`, `work_item_id` or `(workspace_id, state)`; none of them is a search
-- key, and a partial-unique or `@@index` collision here would risk the spurious
-- RENAME the partial-index rule in CLAUDE.md describes (MOTIR-1960).

-- CreateEnum
CREATE TYPE "approval_gate_authority" AS ENUM ('assignee', 'reporter', 'admin');

-- CreateEnum
CREATE TYPE "approval_gate_decision_source" AS ENUM ('ui', 'api', 'mcp', 'github');

-- AlterTable
ALTER TABLE "approval_gate" ADD COLUMN     "decided_by_label" TEXT,
ADD COLUMN     "decided_under_authority" "approval_gate_authority",
ADD COLUMN     "decision_source" "approval_gate_decision_source",
ADD COLUMN     "outcome_ref" TEXT,
ADD COLUMN     "routed_to_id" TEXT,
ADD COLUMN     "subject_version" TEXT;

-- AddForeignKey
ALTER TABLE "approval_gate" ADD CONSTRAINT "approval_gate_routed_to_id_fkey" FOREIGN KEY ("routed_to_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── A DECIDED GATE IS IMMUTABLE (ADR §6a) ───────────────────────────────────
-- "There is no update path for a decided row — audit evidence that can be
-- edited is not evidence."
--
-- The guard is at the DATABASE, not only in the decide door's service, because
-- the service's refusal protects the door and this protects the TABLE: a
-- backfill, a fixture, a future card's repair script and a hand-run `UPDATE` all
-- reach the row without passing through `approvalGatesService`. MOTIR-4790's
-- `approvalGateRepository.decide` carries NO `WHERE state = 'awaiting'` by
-- design — a predicate there would turn a refusal into a silent no-op that
-- reports success — so this trigger is what turns the same mistake into a loud
-- failure instead.
--
-- ⚠️ IT KEYS ON OLD.state, AND THE SET IS THE TWO *DECIDED* STATES ONLY.
--   * `awaiting`   → updatable. It is the state a decision is written FROM, and
--                   the state `superseded` is written from (§6b).
--   * `superseded` → updatable. §6b is explicit that it is NOT a decision: it
--                    carries no actor, no permission and no note, so there is no
--                    evidence on the row to protect. Locking it would buy
--                    nothing and would pre-empt MOTIR-4913, which owns that
--                    state's writer.
--   * `approved` / `changes_requested` → REFUSED. These are the rows a person
--                    made, and they are the whole audit.
--
-- ⚠️ UPDATE ONLY — never DELETE. A gate is `ON DELETE CASCADE` from its
-- workspace, project and work item, so blocking deletes would make deleting a
-- card fail once it had ever been approved. Retention of the SUBJECT's bytes is
-- §6c's pin and a different mechanism entirely; retention of the ROW follows its
-- card.
--
-- ⚠️ AND IT MUST LET THE `SetNull` REFERENTIAL ACTIONS THROUGH, WHICH IS THE ONE
-- THING A NAIVE VERSION OF THIS GUARD GETS WRONG. `decided_by_id` and
-- `routed_to_id` are both `ON DELETE SET NULL`, and Postgres performs that action
-- as an UPDATE of this row — so a guard that refuses every update of a decided
-- gate ALSO refuses `DELETE FROM "user"`, and the first member who ever approved
-- anything becomes undeletable. That inverts MOTIR-4788's whole reason for
-- choosing `SetNull`, and it surfaces as an `AG_DECIDED_IMMUTABLE` raised from a
-- statement that never mentioned this table. (Caught by
-- `tests/approval-gate-audit.test.ts`, which deletes the decider because that is
-- the event `decided_by_label` exists for.)
--
-- So the guard permits EXACTLY that action and nothing else: one or both user FKs
-- going to NULL, with every other column byte-identical. The comparison is over
-- `to_jsonb(NEW)` minus those two keys rather than a hand-written column list,
-- deliberately — a column list is a membership test that silently stops
-- protecting the NEXT column somebody adds, and leaving a new audit column
-- editable is the one failure this trigger exists to prevent. The hole is
-- therefore exactly as wide as the referential action and no wider: the label,
-- the version, the authority, the source, the outcome, the note and the state all
-- stay frozen, which is why losing the FK costs the audit nothing (§6a — the
-- label is what answers "who" after a departure).
--
-- The `AG_DECIDED_IMMUTABLE:` marker + `ERRCODE 23514` pair is the convention
-- this tree's other guards use (`WI_LINK_CYCLE`, `WI_PARENT_CROSS_WORKSPACE`):
-- the repository keys on the marker — a unique string we control — and confirms
-- with the SQLSTATE, so a raw Postgres error never escapes that edge.
--
-- SECURITY INVOKER (the default): the function reads only NEW and OLD, touches no
-- other table, and so needs no privilege the writer lacks. It fires for every
-- writer including the table owner, which is what `FORCE ROW LEVEL SECURITY`
-- already assumes of this table.
CREATE OR REPLACE FUNCTION enforce_approval_gate_decided_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."state" IN ('approved', 'changes_requested') THEN
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

-- No `UPDATE OF <columns>` list, unlike the work_item_link triggers: those guard
-- particular columns, and this guards the ROW. A decided gate's `note_md`, its
-- `subject_version` and its `updated_at` are each as immutable as its `state`,
-- so narrowing the trigger to a column list would leave exactly the edits an
-- audit cares most about unguarded.
CREATE TRIGGER trg_approval_gate_decided_immutable
  BEFORE UPDATE ON "approval_gate"
  FOR EACH ROW EXECUTE FUNCTION enforce_approval_gate_decided_immutable();
