-- The plan CONTENT trail (Story MOTIR-3532 · Subtask MOTIR-3535). Like
-- `20260601092140_add_work_item_revisions`, which this mirrors, it ships THREE
-- things in ONE atomic step:
--   1. the `plan_revision` table + its indexes + FKs, and
--   2. ENABLE/FORCE row-level security on it, and
--   3. the tenancy RLS policy.
--
-- They land together ON PURPOSE (PRODECT_FINDINGS #20): a CREATE TABLE in one
-- migration and its policy in the next leaves a transient window in which the
-- table exists UNGUARDED. One migration -> no window. (And the RLS totality
-- guard in `tests/tenant-root-creation-rls.test.ts` would fail either way: a new
-- table must ship a policy or be added to that suite's deliberately-unguarded
-- map, and this one is not exempt.)
--
-- ⚠️ NO `workspace_id` COLUMN, DELIBERATELY — the same decision
-- `work_item_revision` made and for the same reason: denormalizing tenancy onto
-- a revision row would let it lie about which workspace it belongs to. The
-- policy JOINS to the parent `plan` and tests THAT row's `workspace_id` against
-- the active GUC.

-- CreateTable
CREATE TABLE "plan_revision" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "plan_item_id" TEXT,
    "changed_by_id" TEXT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "change_kind" TEXT NOT NULL,
    "actor_source" "work_item_planning_source",
    "actor_harness" TEXT,
    "actor_model" TEXT,
    "diff" JSONB NOT NULL,

    CONSTRAINT "plan_revision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The timeline's read path: one plan's trail, oldest-first. The composite serves
-- both the RLS join's `plan_id` equality AND the ORDER BY on `changed_at`.
CREATE INDEX "plan_revision_plan_id_changed_at_idx" ON "plan_revision"("plan_id", "changed_at");

-- CreateIndex
-- FK-maintenance indexes for the two nullable parents. Postgres does not index a
-- referencing column automatically, and both parents are rows this product
-- updates (`plan_item` at every deepen) or deletes (`user`, on a hard delete).
CREATE INDEX "plan_revision_plan_item_id_idx" ON "plan_revision"("plan_item_id");

-- CreateIndex
CREATE INDEX "plan_revision_changed_by_id_idx" ON "plan_revision"("changed_by_id");

-- AddForeignKey
-- `plan_id` cascades: a plan's trail lives exactly as long as the plan, like
-- every other child of it (`plan_item` does the same).
ALTER TABLE "plan_revision" ADD CONSTRAINT "plan_revision_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- `plan_item_id` SetNulls: a vanished proposal leaves the change on record,
-- unattached — the same audit-not-ownership call `PlanItem.workItemId` makes.
ALTER TABLE "plan_revision" ADD CONSTRAINT "plan_revision_plan_item_id_fkey" FOREIGN KEY ("plan_item_id") REFERENCES "plan_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
-- `changed_by_id` SetNulls, mirroring `plan.decided_by_id` / `plan.created_by_id`
-- rather than `work_item_revision`'s Restrict: those two are the plan's own actor
-- columns, and a trail row is the third of the same kind. A departed author
-- leaves the change on record, unattributed.
ALTER TABLE "plan_revision" ADD CONSTRAINT "plan_revision_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security (the `work_item_revision` pattern, one parent over)
-- ===========================================================================
-- ENABLE + FORCE so even the table-owner role is subject to the policy. FORCE
-- does NOT defeat BYPASSRLS on the superuser — that is why production connects
-- as the non-bypass app role, and why the RLS tests drop to it.
--
-- Grants: the workspace RLS migration's `ALTER DEFAULT PRIVILEGES IN SCHEMA
-- public ... TO prodect_app` makes every NEW table created by the owner role
-- auto-grantable, so SELECT/INSERT/UPDATE/DELETE are already granted here.
ALTER TABLE "plan_revision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plan_revision" FORCE ROW LEVEL SECURITY;

-- plan_revision: single PERMISSIVE workspace gate, FOR ALL.
--
-- The revision row has no `workspace_id` of its own (see the header), so the
-- policy JOINS to the parent `plan` and tests THAT row's `workspace_id`. The
-- EXISTS subquery resolves via `plan`'s PRIMARY KEY — one index lookup per
-- revision row touched, no scan.
--
-- USING governs SELECT/UPDATE/DELETE visibility: a revision is visible only when
-- its plan is in the active workspace. WITH CHECK governs the post-image of
-- INSERT/UPDATE, closing the "insert a revision pointing at somebody ELSE's
-- plan" hole — the referenced plan must itself be visible under the active GUC
-- or the write is rejected (42501). `current_setting(..., true)` is missing_ok,
-- so an unset GUC yields NULL, the predicate is NULL, and the row is hidden:
-- no context -> nothing visible, which is the safe failure.
CREATE POLICY "plan_revision_active_workspace" ON "plan_revision"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "plan" p
      WHERE p."id" = "plan_revision"."plan_id"
        AND p."workspace_id" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "plan" p
      WHERE p."id" = "plan_revision"."plan_id"
        AND p."workspace_id" = current_setting('app.workspace_id', true)
    )
  );
