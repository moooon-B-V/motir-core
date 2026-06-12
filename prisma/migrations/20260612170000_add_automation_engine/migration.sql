-- Story 6.6 · Subtask 6.6.2 — the execution engine's schema needs (additive
-- over 6.6.1; the 6.6.1 tables apply unchanged, this only extends them).

-- ===========================================================================
-- 1) Idempotency claim — one execution row per (rule, event).
-- The engine claims an (rule_id, event_id) pair before it executes a rule's
-- actions; the partial unique index makes that claim atomic, so an Inngest
-- replay / retry of the same event can never double-execute the actions (the
-- verified "idempotent per event × rule" contract). Partial on
-- `event_id IS NOT NULL` so the rare no-event write (a manual/test row) never
-- collides — Postgres treats NULLs as distinct anyway, but the partial index
-- is explicit about intent and keeps the index small.
-- ===========================================================================
ALTER TABLE "automation_rule_execution" ADD COLUMN "event_id" TEXT;

CREATE UNIQUE INDEX "automation_rule_execution_rule_event_uniq"
  ON "automation_rule_execution" ("rule_id", "event_id")
  WHERE "event_id" IS NOT NULL;

-- ===========================================================================
-- 2) Cross-workspace retention sweep — system-admin RLS branch.
-- The daily 90-day retention sweep (the attachment-GC / filter-subscription-
-- tick precedent) runs under withSystemContext, with no active workspace, so
-- it needs a system-admin branch on the execution policy to DELETE rows across
-- workspaces. The 6.6.1 policy had only the workspace-join branch (a
-- context-less writer didn't exist yet). The parent `automation_rule` keeps its
-- pure workspace gate — only the audit child gets the system path, exactly the
-- saved_filter (no system branch) / saved_filter_subscription (system branch)
-- split. Replaces the 6.6.1 policy in place.
-- ===========================================================================
DROP POLICY "automation_rule_execution_active_workspace" ON "automation_rule_execution";

CREATE POLICY "automation_rule_execution_access" ON "automation_rule_execution"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "automation_rule" ar
      WHERE ar."id" = "automation_rule_execution"."rule_id"
        AND ar."workspace_id" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "automation_rule" ar
      WHERE ar."id" = "automation_rule_execution"."rule_id"
        AND ar."workspace_id" = current_setting('app.workspace_id', true)
    )
  );
