-- Description-upload attachments (Story 2.3 · Subtask 2.3.7, finding #52). In
-- ONE atomic step (table + its policy land together — migration-by-concern,
-- PRODECT_FINDINGS #20 — so there is never an unguarded window):
--   1. the `attachment` table + its index + FKs;
--   2. ENABLE + FORCE row-level security + the tenancy policy.
--
-- RLS shape = a PURE workspace gate, identical to `workflow_status` /
-- `work_item` / `project` (20260602120000 / 20260601074342 / 20260529202445):
-- every row carries a NON-NULL `workspace_id` and every write happens inside an
-- active workspace context (the upload service runs under withWorkspaceContext),
-- so there is no context-less writer and no untenanted row — hence NO
-- `app.system_admin` hatch (unlike job_run). `current_setting('app.workspace_id',
-- true)` with missing_ok=true means an unset GUC → NULL → row hidden (safe
-- failure). FORCE makes even the table-owner role subject to the policy;
-- production connects as the non-bypass `prodect_app` role (PRODECT_FINDINGS #5).
--
-- Grants: the workspace RLS migration's ALTER DEFAULT PRIVILEGES auto-grants
-- CRUD on every new table the `prodect` role creates, so no explicit GRANT here.
--
-- `uploader_user_id` carries a FK (cascade) but the Prisma model keeps it a
-- scalar (no User back-relation) — the DB owns the integrity, the model stays
-- lean. The row is NOT linked to a work_item (Epic 5 adds that column + reuses
-- this table).

-- CreateTable
CREATE TABLE "attachment" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "uploader_user_id" TEXT NOT NULL,
    "blob_url" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "original_filename" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attachment_workspace_id_created_at_idx" ON "attachment"("workspace_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_uploader_user_id_fkey" FOREIGN KEY ("uploader_user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security: pure active-workspace gate (USING governs read/update/
-- delete visibility; WITH CHECK blocks writing a row into a foreign workspace).
ALTER TABLE "attachment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attachment" FORCE ROW LEVEL SECURITY;

CREATE POLICY "attachment_active_workspace" ON "attachment"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
