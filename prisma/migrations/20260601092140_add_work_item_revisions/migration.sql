-- Work-item revision audit trail (Story 1.4 · Subtask 1.4.6). This migration
-- ships THREE things in one atomic step:
--   1. the `work_item_revision` table + its indexes + FKs, and
--   2. ENABLE/FORCE row-level security on it, and
--   3. the tenancy RLS policy.
--
-- They land together ON PURPOSE (PRODECT_FINDINGS #20): 1.4.5's RLS migration
-- deliberately did NOT add a policy for this table because the table did not
-- exist yet, and shipping the CREATE TABLE in a separate migration from its
-- policy would leave a transient window where the table exists UNGUARDED. One
-- migration → no window.
--
-- The application-layer half of the defense-in-depth pair is the
-- workspace-context middleware (lib/workspaces/context.ts · withWorkspace
-- Context) that binds the GUCs these policies read BEFORE any tenant-scoped
-- query runs. Even if a future code path forgets a workspace filter, the
-- policy still blocks cross-tenant reads/writes.

-- CreateTable
CREATE TABLE "work_item_revision" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "changedById" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changeKind" TEXT NOT NULL,
    "diff" JSONB NOT NULL,

    CONSTRAINT "work_item_revision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Activity-feed read path: newest-first history for ONE work item. The
-- (workItemId, changedAt) composite serves both the RLS join's workItemId
-- equality AND listByWorkItem's `ORDER BY changedAt DESC` on the same axis.
CREATE INDEX "work_item_revision_workItemId_changedAt_idx" ON "work_item_revision"("workItemId", "changedAt");

-- CreateIndex
-- Plain workItemId index for FK-maintenance + count-style lookups that don't
-- need the changedAt ordering. (Prisma emits both from the two @@index decls.)
CREATE INDEX "work_item_revision_workItemId_idx" ON "work_item_revision"("workItemId");

-- AddForeignKey
-- workItemId cascades: hard-deleting an issue removes its history with it.
-- (Work items are soft-archived in practice, so this is the rare path.)
ALTER TABLE "work_item_revision" ADD CONSTRAINT "work_item_revision_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- changedById RESTRICTs: a user who ever changed an issue cannot be
-- hard-deleted (mirrors WorkItem.reporter, 1.4.2) — history is preserved.
ALTER TABLE "work_item_revision" ADD CONSTRAINT "work_item_revision_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security (mirrors 20260601074342_add_work_item_rls's pattern)
-- ===========================================================================
-- ENABLE + FORCE so even the table-owner role (`prodect`) is subject to the
-- policy. FORCE does NOT defeat the BYPASSRLS attribute on the superuser —
-- that's why production connects as the non-bypass `prodect_app` role
-- (PRODECT_FINDINGS #5), and why the RLS tests drop to that role.
--
-- Grants: the workspace RLS migration's `ALTER DEFAULT PRIVILEGES IN SCHEMA
-- public ... TO prodect_app` makes every NEW table created by the `prodect`
-- role auto-grantable to prodect_app. `work_item_revision` is created by that
-- role here, so SELECT/INSERT/UPDATE/DELETE are already granted. No explicit
-- GRANT needed.
ALTER TABLE "work_item_revision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "work_item_revision" FORCE ROW LEVEL SECURITY;

-- work_item_revision: single PERMISSIVE workspace gate, FOR ALL.
--
-- STRUCTURALLY DIFFERENT from the work_item / work_item_link policies: the
-- revision row has NO `workspaceId` column (by design — denormalizing tenancy
-- onto a revision would let it lie about which workspace it belongs to). The
-- policy therefore JOINS to the parent work_item and tests THAT row's
-- workspaceId against the active GUC.
--
-- The EXISTS subquery is cheap: `w."id" = ...workItemId` resolves via the
-- work_item PRIMARY KEY (work_item_pkey) — a single index lookup per revision
-- row touched, no scan. (The activity-feed read path is cheap on the OTHER
-- axis via this table's own (workItemId, changedAt) index.)
--
-- USING governs SELECT/UPDATE/DELETE visibility (a revision is only visible
-- when its parent work item is in the active workspace). WITH CHECK governs
-- the post-image of INSERT/UPDATE: it closes the "user inserts a revision
-- whose workItemId points at someone ELSE's work item" hole — the referenced
-- work_item must itself be visible under the active workspace GUC, or the
-- write is rejected (42501). current_setting(..., true) is missing_ok, so an
-- unset GUC yields NULL → the predicate is NULL → row hidden (safe failure:
-- no context → nothing visible).
CREATE POLICY "work_item_revision_active_workspace" ON "work_item_revision"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "work_item" w
      WHERE w."id" = "work_item_revision"."workItemId"
        AND w."workspaceId" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "work_item" w
      WHERE w."id" = "work_item_revision"."workItemId"
        AND w."workspaceId" = current_setting('app.workspace_id', true)
    )
  );
