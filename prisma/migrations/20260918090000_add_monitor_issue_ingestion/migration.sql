-- Monitor-issue INGESTION store (Story MOTIR-4929 · Subtask MOTIR-5576) — the
-- `monitor_issue` link set the reconciling poll writes, and the ingestion state
-- it keeps on each `monitor_connection`. In ONE atomic step (columns + table +
-- indexes + FKs + the table's RLS policy land together — migration-by-concern,
-- PRODECT_FINDINGS #20 — so there is never an unguarded window):
--   1. `monitor_connection` gains its seven ingestion columns and the binder FK;
--   2. `monitor_issue`, its unique + indexes and its four FKs;
--   3. ENABLE + FORCE row-level security + a workspace-or-system policy on it.
--
-- ── THE DEDUP KEY IS `(connection_id, external_issue_id)` ────────────────────
-- The provider's own ISSUE id, not its fingerprint (the fingerprint is the
-- provider's grouping decision and can change under us). The UNIQUE index is
-- the mechanism: two reconcilers of one issue can run at once, and the
-- repository's claim-or-lock (`INSERT … ON CONFLICT DO NOTHING` then
-- `SELECT … FOR UPDATE`) rests on it. Its column list is not the column list of
-- any plain index on the model, so Prisma's by-column-list pairing has nothing
-- to pair it against (the CLAUDE.md partial/unique-index rule, MOTIR-1960).
--
-- ── `work_item_id` is ON DELETE SET NULL, and that is load-bearing ──────────
-- A deleted bug leaves the issue row with a null pointer and its
-- `filed_work_item_identifier` intact — which is exactly how the reconciler
-- tells "its work item was deleted" (re-file, naming the old key) apart from
-- "never filed". NOT unique: many issues may point at one work item.
--
-- ── `bound_by_user_id` is ON DELETE SET NULL ─────────────────────────────────
-- The person whose identity the reconciler files as. Existing rows get NULL and
-- nothing is invented for them: the reconciler records a named failure telling
-- a person to re-bind.
--
-- ── RLS shape = workspace-or-system, modelled on `monitor_connection`
-- (20260912120000) ──────────────────────────────────────────────────────────
-- The poll is an unattended job that opens a SYSTEM transaction and reaches this
-- table before it knows whose rows they are, so a pure workspace arm would read
-- ZERO ROWS AND RAISE NOTHING — the silent-stop failure MOTIR-4918 recorded. The
-- policy reads the row's OWN `workspace_id` (no correlated EXISTS through the
-- binding). No explicit GRANT: the workspace-RLS migration's default privileges
-- auto-grant every new owner-created table to `motir_app`.

-- AlterTable
ALTER TABLE "monitor_connection" ADD COLUMN     "bound_by_user_id" TEXT,
ADD COLUMN     "last_poll_error" TEXT,
ADD COLUMN     "last_poll_filed_count" INTEGER,
ADD COLUMN     "last_poll_status" TEXT,
ADD COLUMN     "last_poll_succeeded_at" TIMESTAMP(3),
ADD COLUMN     "last_polled_at" TIMESTAMP(3),
ADD COLUMN     "last_seen_watermark" TIMESTAMP(3),
ADD COLUMN     "minimum_level" TEXT;

-- CreateTable
CREATE TABLE "monitor_issue" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "external_issue_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "culprit" TEXT,
    "level" TEXT,
    "permalink" TEXT,
    "event_count" INTEGER NOT NULL DEFAULT 0,
    "first_seen_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "work_item_id" TEXT,
    "filed_work_item_identifier" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monitor_issue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "monitor_issue_work_item_id_idx" ON "monitor_issue"("work_item_id");

-- CreateIndex
CREATE INDEX "monitor_issue_workspace_id_idx" ON "monitor_issue"("workspace_id");

-- CreateIndex
CREATE INDEX "monitor_issue_project_id_idx" ON "monitor_issue"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "monitor_issue_connection_id_external_issue_id_key" ON "monitor_issue"("connection_id", "external_issue_id");

-- CreateIndex
CREATE INDEX "monitor_connection_bound_by_user_id_idx" ON "monitor_connection"("bound_by_user_id");

-- AddForeignKey
ALTER TABLE "monitor_connection" ADD CONSTRAINT "monitor_connection_bound_by_user_id_fkey" FOREIGN KEY ("bound_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor_issue" ADD CONSTRAINT "monitor_issue_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "monitor_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor_issue" ADD CONSTRAINT "monitor_issue_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor_issue" ADD CONSTRAINT "monitor_issue_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor_issue" ADD CONSTRAINT "monitor_issue_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — monitor_issue (its OWN workspace_id, no join)
-- ===========================================================================
ALTER TABLE "monitor_issue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "monitor_issue" FORCE ROW LEVEL SECURITY;

CREATE POLICY "monitor_issue_workspace_or_system" ON "monitor_issue"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  );
