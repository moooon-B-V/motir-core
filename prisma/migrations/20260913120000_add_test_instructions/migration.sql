-- HOW TO TEST records (Story MOTIR-4906 · Subtask MOTIR-5328, re-planned
-- 2026-09-13: per RUN on the run target — `docs/decisions/approval-gates.md` §9's
-- amendment). In ONE atomic, ADDITIVE step (tables + indexes + FKs + the partial
-- unique index + RLS land together, so there is never an unguarded window, and
-- nothing existing changes — it ships in one deploy with no expand/contract).
--
-- Two tables: `test_instructions` is one row per publish (one per RUN) on the run
-- target, carrying the run's rich-text body (`body_md`); `test_instructions_repo`
-- is that record's per-repository sections (the commit each was written for).
--
-- RLS shape = a PURE active-workspace gate on BOTH tables, identical to
-- `design_evidence` (20260811145123): every row carries a NON-NULL
-- `workspace_id` and every write happens inside an active workspace context
-- (`testInstructionsService.publish` runs under withWorkspaceContext), so there
-- is no context-less writer and no `app.system_admin` hatch.
-- `current_setting('app.workspace_id', true)` with missing_ok=true means an unset
-- GUC → NULL → row hidden (safe failure). Uncorrelated by construction.
--
-- Every FK is modelled on BOTH sides in schema.prisma (the @relation rule).

-- CreateTable
CREATE TABLE "test_instructions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "body_md" TEXT NOT NULL,
    "preview_path" TEXT,
    "dispatch_run_id" TEXT,
    "published_by_id" TEXT,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_instructions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_instructions_repo" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "test_instructions_id" TEXT NOT NULL,
    "repo_id" TEXT NOT NULL,
    "commit_sha" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "test_instructions_repo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "test_instructions_work_item_id_created_at_idx" ON "test_instructions"("work_item_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "test_instructions_workspace_id_idx" ON "test_instructions"("workspace_id");

-- CreateIndex
CREATE INDEX "test_instructions_repo_repo_id_idx" ON "test_instructions_repo"("repo_id");

-- CreateIndex
CREATE INDEX "test_instructions_repo_workspace_id_idx" ON "test_instructions_repo"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "test_instructions_repo_test_instructions_id_repo_id_key" ON "test_instructions_repo"("test_instructions_id", "repo_id");

-- AddForeignKey
ALTER TABLE "test_instructions" ADD CONSTRAINT "test_instructions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_instructions" ADD CONSTRAINT "test_instructions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_instructions" ADD CONSTRAINT "test_instructions_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_instructions" ADD CONSTRAINT "test_instructions_dispatch_run_id_fkey" FOREIGN KEY ("dispatch_run_id") REFERENCES "dispatch_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_instructions" ADD CONSTRAINT "test_instructions_published_by_id_fkey" FOREIGN KEY ("published_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_instructions_repo" ADD CONSTRAINT "test_instructions_repo_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_instructions_repo" ADD CONSTRAINT "test_instructions_repo_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_instructions_repo" ADD CONSTRAINT "test_instructions_repo_test_instructions_id_fkey" FOREIGN KEY ("test_instructions_id") REFERENCES "test_instructions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_instructions_repo" ADD CONSTRAINT "test_instructions_repo_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "github_repo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The load-bearing invariant: AT MOST ONE current record per run target. A
-- partial unique index (only current rows participate) is the DB-level backstop
-- behind the service's row lock, so a publish race can never leave two current
-- rows. History rows (is_current=false) are unconstrained.
--
-- ⚠️ Its column list (work_item_id) is deliberately NOT the column list of any
-- `@@index` on this model — Prisma's differ pairs a DB index to a datamodel index
-- BY COLUMN LIST and cannot express a WHERE clause, so a collision would surface
-- as a permanent spurious RENAME (MOTIR-1960).
CREATE UNIQUE INDEX "test_instructions_one_current_per_item"
  ON "test_instructions" ("work_item_id")
  WHERE "is_current";

-- Row-level security: pure active-workspace gate (USING governs read/update/
-- delete visibility; WITH CHECK blocks writing a row into a foreign workspace).
ALTER TABLE "test_instructions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "test_instructions" FORCE ROW LEVEL SECURITY;

CREATE POLICY "test_instructions_active_workspace" ON "test_instructions"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER TABLE "test_instructions_repo" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "test_instructions_repo" FORCE ROW LEVEL SECURITY;

CREATE POLICY "test_instructions_repo_active_workspace" ON "test_instructions_repo"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
