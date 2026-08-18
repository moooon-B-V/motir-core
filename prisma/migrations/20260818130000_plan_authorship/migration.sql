-- ===========================================================================
-- The Plan's AUTHORSHIP carrier (MOTIR-2986, Story MOTIR-2982) — three nullable
-- columns recording WHO wrote a plan.
--
-- Decided in `docs/decisions/agent-authored-plans.md` Q3. A `Plan` already
-- records `origin` (WHY it was started — `user` / `cadence`) and `source_job_id`
-- (WHICH motir-ai job produced it), and neither answers WHO authored it: an
-- agent-authored plan and a Motir generation are both `origin = 'user'`, and
-- `source_job_id IS NULL` is an INFERENCE, not a record. So the
-- `source · harness · model` triple `work-item-provenance.md` Decision 2 fixes
-- one level down is mirrored onto the plan itself.
--
-- ---------------------------------------------------------------------------
-- WHY `work_item_planning_source` IS REUSED RATHER THAN DUPLICATED
-- ---------------------------------------------------------------------------
-- The enum's name is now slightly wider than its original scope, and that is the
-- deliberate, cheaper half of the trade. A plan's author and the authors stamped
-- on the work items it materializes MUST be drawn from ONE closed vocabulary, or
-- the Plans surface and the work-item detail can disagree about the same fact —
-- and a parallel `plan_author_source` with the same three members would be a
-- second display switch to keep total, forever, for no expressive gain.
--
-- ---------------------------------------------------------------------------
-- NULLABLE, NO DEFAULT, NO BACKFILL
-- ---------------------------------------------------------------------------
-- Every plan that exists when this lands genuinely has no recorded author —
-- these columns' only writer is the `create_plan` MCP tool (MOTIR-2988), which
-- does not exist yet. NULL is therefore a MEANING, not a gap: it is the
-- *unattributed* state the Plans surface draws (MOTIR-2985). Inventing a value
-- for history is the one outcome worse than showing nothing.
--
-- Motir's OWN generator is not retrofitted here either: `aiGenerationService` /
-- `aiPlanEditsService` keep calling `createPlan` without the triple, so their
-- plans stay NULL and behave byte-identically. That is MOTIR-2996's card, which
-- backfills the job-sourced rows and retires the `source_job_id` inference the
-- surface stands on in the meantime.
--
-- ---------------------------------------------------------------------------
-- RLS AND TENANCY ARE UNCHANGED
-- ---------------------------------------------------------------------------
-- This is a COLUMN ADDITION to an existing workspace-scoped table, not a new
-- table. `plan`'s policy already governs the row by `workspace_id`; adding
-- columns changes neither the policy nor which rows a tenant can see, so there
-- is no new arm to write and nothing for the tenant-root guard to cover.
--
-- ---------------------------------------------------------------------------
-- AND `created_by_id` — WHO ASKED, which is a THIRD party, not a synonym
-- ---------------------------------------------------------------------------
-- A plan has up to three parties and they are commonly three different people:
-- a teammate ASKS for it, an agent (or Motir) WRITES it, a lead APPROVES it.
-- Only the third was recorded (`decided_by_id`). The first is the one a reviewer
-- asks for first — *somebody's* credential produced this, whose?* — and an
-- agent-authored plan makes the question sharper rather than softer: the MCP
-- token belongs to a person, and a Motir generation was clicked by one.
--
-- ⚠️ NULLABLE, AND NULL IS THE `cadence` CASE — NOT A GAP.
-- `autoPlanCadenceService` runs the watcher under the PROJECT OWNER's
-- credential (`{ userId: owner.userId }`) so the job has one; nobody clicked
-- anything. Defaulting this column from the acting context would therefore
-- attribute to that owner a request they never made — on the ONE plan whose
-- whole point is that no person asked. So the requester is written ⟺
-- `origin = 'user'`, and a cadence plan is identified by its `origin`.
--
-- `ON DELETE SET NULL`, matching `decided_by_id`: deleting a user must not
-- cascade away the plan they asked for, and an unattributable plan is a
-- correct reading of a departed requester.
--
-- No index on any of these: nothing filters or orders on them. They are read on
-- a row already fetched by id or by `(project_id, created_at)`.
-- ===========================================================================

ALTER TABLE "plan"
  ADD COLUMN "author_source" "work_item_planning_source",
  ADD COLUMN "author_harness" TEXT,
  ADD COLUMN "author_model" TEXT,
  ADD COLUMN "created_by_id" TEXT;

ALTER TABLE "plan"
  ADD CONSTRAINT "plan_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
