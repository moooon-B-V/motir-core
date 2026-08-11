-- Published DESIGN RESULTS (Story MOTIR-2664 · Subtask MOTIR-2666). In ONE
-- atomic step (tables + indexes + FKs + their RLS policies land together —
-- migration-by-concern, PRODECT_FINDINGS #20 — so there is never an unguarded
-- window):
--   1. the `design_asset_kind` enum + the `design_asset` attachment source;
--   2. the `design_evidence` + `design_asset` tables, indexes and FKs;
--   3. the partial-unique index enforcing ONE current result per work item;
--   4. ENABLE + FORCE row-level security + the pure active-workspace policies.
--
-- RLS shape = a PURE workspace gate, identical to `attachment`
-- (20260603120000) and `acceptance_evidence` (20260705222141): every row
-- carries a NON-NULL `workspace_id` and every write happens inside an active
-- workspace context (the publish path — MOTIR-2667 — runs under
-- withWorkspaceContext), so there is no context-less writer and no untenanted
-- row — hence NO `app.system_admin` hatch. `current_setting('app.workspace_id',
-- true)` with missing_ok=true means an unset GUC → NULL → row hidden (safe
-- failure). FORCE subjects even the table owner to the policy; production
-- connects as the non-bypass `prodect_app` role.
--
-- ⚠️ `design_asset` carries its OWN `workspace_id` rather than reaching the
-- parent's through a join. A join-based policy would run a correlated subquery
-- per row on the panel read and would make the child's visibility depend on the
-- parent's policy evaluating first; the denormalized column keeps the policy a
-- pure gate and matches every other tenanted table here. The service writes both
-- rows in one transaction from the same resolved workspace, so they cannot drift.
--
-- Every FK is a real constraint modelled on BOTH sides in schema.prisma (the
-- @relation migration rule): workspace Cascade, work_item Cascade (a result dies
-- with its card), design_evidence Cascade (assets die with their result),
-- attachment SetNull (the orphan-GC deleting a superseded mock's blob leaves the
-- asset row — and the record of what was published — standing).

-- CreateEnum
CREATE TYPE "design_asset_kind" AS ENUM ('mock', 'image', 'note_file');

-- AlterEnum
ALTER TYPE "attachment_source" ADD VALUE 'design_asset';

-- CreateTable
CREATE TABLE "design_evidence" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "note_md" TEXT,
    "note_truncated" BOOLEAN NOT NULL DEFAULT false,
    "commit_sha" TEXT,
    "ci_run_url" TEXT,
    "produced_by_key" TEXT,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "design_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "design_asset" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "design_evidence_id" TEXT NOT NULL,
    "kind" "design_asset_kind" NOT NULL,
    "attachment_id" TEXT,
    "source_path" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "design_asset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "design_evidence_work_item_id_created_at_idx" ON "design_evidence"("work_item_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "design_asset_attachment_id_key" ON "design_asset"("attachment_id");

-- CreateIndex
CREATE INDEX "design_asset_design_evidence_id_position_idx" ON "design_asset"("design_evidence_id", "position");

-- AddForeignKey
ALTER TABLE "design_evidence" ADD CONSTRAINT "design_evidence_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_evidence" ADD CONSTRAINT "design_evidence_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_asset" ADD CONSTRAINT "design_asset_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_asset" ADD CONSTRAINT "design_asset_design_evidence_id_fkey" FOREIGN KEY ("design_evidence_id") REFERENCES "design_evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_asset" ADD CONSTRAINT "design_asset_attachment_id_fkey" FOREIGN KEY ("attachment_id") REFERENCES "attachment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The load-bearing invariant: AT MOST ONE current design result per work item.
-- A partial unique index (only current rows participate) enforces it at the DB
-- level, so a supersede race can never leave two current rows — the loser hits
-- the unique violation and the service retries. Superseded history rows
-- (is_current=false) are unconstrained.
--
-- ⚠️ Its column list is deliberately NOT the column list of any `@@index` on
-- this model: Prisma's differ pairs a DB index to a datamodel index BY COLUMN
-- LIST and cannot express a WHERE clause, so a collision would surface as a
-- permanent spurious RENAME on every `migrate dev` (the partial-index rule in
-- CLAUDE.md, MOTIR-1960). `design_evidence_work_item_id_created_at_idx` is
-- (work_item_id, created_at), this one is (work_item_id) — no pairing.
CREATE UNIQUE INDEX "design_evidence_one_current_per_item"
  ON "design_evidence" ("work_item_id")
  WHERE "is_current";

-- Row-level security: pure active-workspace gate on both tables (USING governs
-- read/update/delete visibility; WITH CHECK blocks writing a row into a foreign
-- workspace).
ALTER TABLE "design_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "design_evidence" FORCE ROW LEVEL SECURITY;

CREATE POLICY "design_evidence_active_workspace" ON "design_evidence"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER TABLE "design_asset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "design_asset" FORCE ROW LEVEL SECURITY;

CREATE POLICY "design_asset_active_workspace" ON "design_asset"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
