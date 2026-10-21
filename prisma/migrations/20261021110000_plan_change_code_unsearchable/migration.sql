-- MOTIR-9167 — a planning phase that cannot SEARCH a target repository's code stops
-- and tells the person (MOTIR-9165). Two additive pieces, both EXPAND-ONLY:
--
--   * `plan_change_run_pauses.unsearchable_repos` — the blocked target repositories
--     and why, as `[{ repoRef, state }]`. Set exactly when the pause's kind is the new
--     `code_unsearchable`; null on every existing row.
--   * `plan_change_turn.code_unsearchable` — the same list on the `assistant` turn a
--     conversation writes when it stopped for the same reason before any planning job
--     opened. Null on every existing row.
--
-- The run-pause CHECKs are LOOSENED (never tightened) so the old release's two kinds
-- and three answers stay valid for it while a retired machine drains.

ALTER TABLE "plan_change_run_pauses" ADD COLUMN "unsearchable_repos" JSONB;
ALTER TABLE "plan_change_turn" ADD COLUMN "code_unsearchable" JSONB;

ALTER TABLE "plan_change_run_pauses"
  DROP CONSTRAINT "plan_change_run_pauses_kind_check",
  DROP CONSTRAINT "plan_change_run_pauses_text_matches_kind_check",
  DROP CONSTRAINT "plan_change_run_pauses_answer_check";

ALTER TABLE "plan_change_run_pauses"
  ADD CONSTRAINT "plan_change_run_pauses_kind_check" CHECK ("kind" IN ('replan', 'unclear', 'code_unsearchable')),
  ADD CONSTRAINT "plan_change_run_pauses_text_matches_kind_check" CHECK (
    ("kind" = 'replan' AND "reason" IS NOT NULL AND "question" IS NULL AND "unsearchable_repos" IS NULL)
    OR ("kind" = 'unclear' AND "question" IS NOT NULL AND "reason" IS NULL AND "unsearchable_repos" IS NULL)
    OR ("kind" = 'code_unsearchable' AND "reason" IS NULL AND "question" IS NULL AND "unsearchable_repos" IS NOT NULL)
  ),
  ADD CONSTRAINT "plan_change_run_pauses_answer_check" CHECK (
    "answer" IS NULL OR "answer" IN ('start_over', 'apply', 'replied', 'resumed')
  );
