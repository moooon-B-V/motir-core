-- Attachment → work_item link (Story 5.2 · Subtask 5.2.1). The linking layer
-- 2.3.7 deliberately left out (finding #52): `work_item_id` (NULLABLE — rows
-- are born unlinked: an editor upload at create-modal time happens before the
-- issue exists, and every pre-5.2 audit row predates the link) + `source`
-- (where the row entered: the Markdown editor vs the attachments panel — the
-- panel BLOCKS deleting editor-sourced rows, the Jira-verified broken-embed
-- guard) + the paged-panel-read index.
--
-- FK action is ON DELETE SET NULL, NOT CASCADE: hard-deleting an issue must
-- leave the attachment ROW behind (unlinked) so the orphan-GC (5.2.7) can
-- remove the BLOB too — a cascade would vaporise the rows and strand their
-- blobs invisibly. The FK is modelled as a two-sided Prisma `@relation`
-- (`Attachment.workItem` ↔ `WorkItem.attachments`) per the FK-drift rule
-- (bug-attachment-fk-migration-drift), so `migrate dev` re-runs report
-- "No difference detected".
--
-- `source` backfill: ADD COLUMN ... NOT NULL DEFAULT 'editor' stamps every
-- existing row `editor` — correct, because the editor upload path is the only
-- writer that exists before 5.2.

-- CreateEnum
CREATE TYPE "attachment_source" AS ENUM ('editor', 'panel');

-- AlterTable
ALTER TABLE "attachment" ADD COLUMN     "source" "attachment_source" NOT NULL DEFAULT 'editor',
ADD COLUMN     "work_item_id" TEXT;

-- CreateIndex
CREATE INDEX "attachment_work_item_id_created_at_idx" ON "attachment"("work_item_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- RLS: add the `app.system_admin` hatch to the attachment policy.
--
-- The 2.3.7 policy was the PURE workspace gate, and its header recorded why:
-- "there is no context-less writer and no untenanted row — hence NO
-- app.system_admin hatch (unlike job_run)". Story 5.2 changes that premise:
-- the orphan-GC job (5.2.7, on the 1.6 defineJob harness) is EXACTLY the
-- context-less background runtime the job_run hatch exists for — it runs
-- outside any HTTP request, holds no workspace context, and must read
-- (`listOrphans`) and delete unlinked rows ACROSS workspaces under the
-- non-bypass `prodect_app` role. Without the hatch, the GC sees zero rows in
-- production and the repo method is dead code. This is the same criterion the
-- boards migration (20260606120000) used to REFUSE the hatch — "the hatch
-- exists ONLY where the writer is the context-less background runtime" — now
-- satisfied, so the hatch is added rather than refused.
--
-- Tenant paths are unchanged: requests bind only app.user_id / app.workspace_id
-- / app.project_id via withWorkspaceContext, and `app.system_admin` is bound
-- exclusively by withSystemContext (a constant, never user input — see
-- lib/workspaces/context.ts), so a tenant cannot elevate itself.
-- ===========================================================================

DROP POLICY "attachment_active_workspace" ON "attachment";

CREATE POLICY "attachment_workspace_or_system_admin" ON "attachment"
  FOR ALL
  USING (
    "workspace_id" = current_setting('app.workspace_id', true)
    OR current_setting('app.system_admin', true) = 'true'
  )
  WITH CHECK (
    "workspace_id" = current_setting('app.workspace_id', true)
    OR current_setting('app.system_admin', true) = 'true'
  );
