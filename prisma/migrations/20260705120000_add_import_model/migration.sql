-- The issue-importer persistence substrate (Story 7.16 / MOTIR-939, decided in
-- MOTIR-938): the `import` RUN record + the `imported_issue` external-id MAP that
-- makes re-runs idempotent. This card is the SCHEMA + repositories; the
-- mapping/persist engine that owns the transaction + the create-vs-update
-- decision is MOTIR-941.
--
-- Both tables are workspace-scoped tenant data, so they land WITH their RLS
-- policy in this same migration (migration-by-concern, PRODECT_FINDINGS #20 — no
-- unguarded window). Every FK is modelled as a Prisma `@relation` (forward +
-- back-relation) with the SAME actions the SQL uses, so `migrate dev` reports "No
-- difference detected" (the FK-`@relation` rule, bug-attachment-fk-migration-drift):
-- workspace/project CASCADE (tenant + project teardown); `import.created_by`
-- SET NULL (a deleted initiator never destroys import history — the
-- `plan.decided_by` precedent); `imported_issue.import` SET NULL (the map SURVIVES
-- an import-run delete, so a re-run stays idempotent — the key is the stable source
-- identity, not the run); `imported_issue.work_item` CASCADE (delete the work item
-- and its mapping row goes too, so a re-import re-creates it).
--
-- `imported_issue`'s `@@unique(project_id, source, external_id)` is the idempotency
-- guarantee AT THE DB (MOTIR-938's Atlassian external-id-skip precedent): a second
-- import of the same external id cannot insert a second mapping row — not merely
-- "the app checks first".

-- CreateEnum
CREATE TYPE "import_source" AS ENUM ('jira', 'linear', 'github', 'plane', 'csv');

-- CreateEnum
CREATE TYPE "import_status" AS ENUM ('draft', 'previewed', 'running', 'succeeded', 'partially_failed', 'failed');

-- CreateTable
CREATE TABLE "import" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "source" "import_source" NOT NULL,
    "source_ref" TEXT,
    "mapping" JSONB,
    "status" "import_status" NOT NULL DEFAULT 'draft',
    "created_count" INTEGER NOT NULL DEFAULT 0,
    "updated_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "imported_issue" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "import_id" TEXT,
    "source" "import_source" NOT NULL,
    "external_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "source_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "imported_issue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_workspace_id_idx" ON "import"("workspace_id");

-- CreateIndex
CREATE INDEX "import_project_id_created_at_idx" ON "import"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "imported_issue_workspace_id_idx" ON "imported_issue"("workspace_id");

-- CreateIndex
CREATE INDEX "imported_issue_import_id_idx" ON "imported_issue"("import_id");

-- CreateIndex
CREATE INDEX "imported_issue_work_item_id_idx" ON "imported_issue"("work_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "imported_issue_project_id_source_external_id_key" ON "imported_issue"("project_id", "source", "external_id");

-- AddForeignKey
ALTER TABLE "import" ADD CONSTRAINT "import_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import" ADD CONSTRAINT "import_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import" ADD CONSTRAINT "import_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imported_issue" ADD CONSTRAINT "imported_issue_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imported_issue" ADD CONSTRAINT "imported_issue_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imported_issue" ADD CONSTRAINT "imported_issue_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "import"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imported_issue" ADD CONSTRAINT "imported_issue_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — import (pure workspace gate, no escape hatch)
-- ===========================================================================
-- The SAME single PERMISSIVE FOR ALL policy as sprint / comment / plan:
-- USING + WITH CHECK against current_setting('app.workspace_id', true) (`true` =
-- missing_ok, so an unset GUC yields NULL → predicate NULL → row hidden, the safe
-- failure). ENABLE + FORCE so even the table-owner `prodect` role is subject to it
-- (production + the service writes connect as the non-BYPASSRLS `prodect_app`
-- role). The workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO prodect_app`
-- auto-grants on every NEW table created by the `prodect` role, so no explicit
-- GRANT is needed (same as sprint / comment / plan).
ALTER TABLE "import" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import" FORCE ROW LEVEL SECURITY;

CREATE POLICY "import_active_workspace" ON "import"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

-- ===========================================================================
-- Row-level security — imported_issue (pure workspace gate, no escape hatch)
-- ===========================================================================
ALTER TABLE "imported_issue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "imported_issue" FORCE ROW LEVEL SECURITY;

CREATE POLICY "imported_issue_active_workspace" ON "imported_issue"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
