-- Story-acceptance evidence (Story MOTIR-1627 · Subtask MOTIR-1629). In ONE
-- atomic step (table + index + FKs + its RLS policy land together —
-- migration-by-concern, PRODECT_FINDINGS #20 — so there is never an unguarded
-- window):
--   1. the `acceptance_evidence` table + indexes + FKs;
--   2. the partial-unique index enforcing ONE current evidence per story;
--   3. ENABLE + FORCE row-level security + the pure active-workspace policy.
--
-- RLS shape = a PURE workspace gate, identical to `attachment`
-- (20260603120000): every row carries a NON-NULL `workspace_id` and every write
-- happens inside an active workspace context (the publish path — MOTIR-1631 —
-- runs under withWorkspaceContext), so there is no context-less writer and no
-- untenanted row — hence NO `app.system_admin` hatch. `current_setting(
-- 'app.workspace_id', true)` with missing_ok=true means an unset GUC → NULL →
-- row hidden (safe failure). FORCE subjects even the table owner to the policy;
-- production connects as the non-bypass `prodect_app` role.
--
-- Every FK is a real constraint modelled on BOTH sides in schema.prisma (the
-- @relation migration rule): work_item Cascade (evidence dies with its story),
-- attachment SetNull (the orphan-GC deleting a superseded video's blob leaves
-- the history row), approved_by SetNull (the approval stamp outlives its user).

-- CreateEnum
CREATE TYPE "acceptance_evidence_status" AS ENUM ('pending', 'approved', 'changes_requested');

-- AlterEnum
ALTER TYPE "attachment_source" ADD VALUE 'acceptance_video';

-- CreateTable
CREATE TABLE "acceptance_evidence" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "attachment_id" TEXT,
    "trace_url" TEXT,
    "chapters" JSONB NOT NULL DEFAULT '[]',
    "status" "acceptance_evidence_status" NOT NULL DEFAULT 'pending',
    "commit_sha" TEXT,
    "ci_run_url" TEXT,
    "produced_by_key" TEXT,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acceptance_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "acceptance_evidence_attachment_id_key" ON "acceptance_evidence"("attachment_id");

-- CreateIndex
CREATE INDEX "acceptance_evidence_work_item_id_created_at_idx" ON "acceptance_evidence"("work_item_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "acceptance_evidence" ADD CONSTRAINT "acceptance_evidence_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acceptance_evidence" ADD CONSTRAINT "acceptance_evidence_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acceptance_evidence" ADD CONSTRAINT "acceptance_evidence_attachment_id_fkey" FOREIGN KEY ("attachment_id") REFERENCES "attachment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acceptance_evidence" ADD CONSTRAINT "acceptance_evidence_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The load-bearing invariant: AT MOST ONE current evidence per story. A partial
-- unique index (only current rows participate) enforces it at the DB level, so
-- a supersede race can never leave two current rows — the loser hits the unique
-- violation and the service retries. Superseded history rows (is_current=false)
-- are unconstrained.
CREATE UNIQUE INDEX "acceptance_evidence_one_current_per_story"
  ON "acceptance_evidence" ("work_item_id")
  WHERE "is_current";

-- Row-level security: pure active-workspace gate (USING governs read/update/
-- delete visibility; WITH CHECK blocks writing a row into a foreign workspace).
ALTER TABLE "acceptance_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "acceptance_evidence" FORCE ROW LEVEL SECURITY;

CREATE POLICY "acceptance_evidence_active_workspace" ON "acceptance_evidence"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
