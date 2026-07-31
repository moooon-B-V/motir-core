-- MOTIR-1907 — the per-row CI-Actions INTENT on `project_repository`.
--
-- `docs/decisions/ci-minutes-allowance.md` §A / §6.5. When an organization enters
-- `ci_credits_exhausted`, Motir disables GitHub Actions on every repository it
-- OWNS for that org. That fan-out is N GitHub calls with NO transaction over
-- them, so what the database records is the INTENT, not the outcome: half the
-- calls can fail and the next sweep must be able to finish the job rather than
-- lose it.
--
-- WHY TWO TIMESTAMPS AND NOT A `pending` BOOLEAN. A boolean flag has to be
-- CLEARED by the same code path that sets it, so a crash between the GitHub call
-- and the clear leaves it lying — and a liar here means either a permanently
-- "pending" repo nobody re-asserts, or one reported settled that never was.
-- Comparing `ci_actions_applied_at` against `ci_actions_intent_at` is DERIVED
-- state: it cannot desynchronise, a re-run recomputes the same answer, and the
-- convergence predicate is a single expression —
--
--   needs assertion  ⟺  ci_actions_intent_at IS NOT NULL
--                       AND (ci_actions_applied_at IS NULL
--                            OR ci_actions_applied_at < ci_actions_intent_at)
--
-- The `intent_at IS NOT NULL` arm is what stops this matching every row that has
-- never been touched: "no intent expressed" is not "unconverged" — Actions
-- enabled is already the desired state for a fresh repository. And `applied_at`
-- is written by COPYING `intent_at`, never by stamping a clock, so convergence is
-- an equality between two values from ONE clock rather than a comparison across
-- two (see `projectRepoRepository.markCiActionsApplied`).
--
-- NO RLS CHANGE. `project_repository_active_workspace` is already FOR ALL and
-- predicates purely on `workspace_id = current_setting('app.workspace_id')`;
-- these are three more columns on an already-guarded table, so they inherit that
-- policy unchanged. The service reads them under the per-workspace GUC exactly
-- as the meter reads the rest of this table (`ciMinutesMeterService` §5.2 — this
-- table has NO `app.system_admin` escape and must not grow one here).
--
-- BACKFILL. `false` / NULL / NULL is the honest starting state for every existing
-- row: no intent has ever been expressed, so nothing has been applied. The first
-- entitlement pass that sees the org stamps the rows it means to change.

ALTER TABLE "project_repository"
  ADD COLUMN "ci_actions_disabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "ci_actions_intent_at" TIMESTAMP(3),
  ADD COLUMN "ci_actions_applied_at" TIMESTAMP(3);

-- The sweep's read is "rows in this workspace whose intent is not yet applied".
-- Partial index on exactly that predicate: the settled rows (the overwhelming
-- majority, always) are not in the index at all, so the sweep stays cheap as the
-- table grows and a fully-converged tenant costs an empty scan.
CREATE INDEX "project_repository_ci_actions_pending_idx"
  ON "project_repository" ("workspace_id")
  WHERE "ci_actions_intent_at" IS NOT NULL
    AND ("ci_actions_applied_at" IS NULL
         OR "ci_actions_applied_at" < "ci_actions_intent_at");
