-- A plan being written, followed (Story MOTIR-7820 · Subtask MOTIR-7822).
--
-- Two facts a `generating` plan could not hold: WHAT each running planner
-- session is working on right now, and WHEN anything last happened to the plan.
-- Like `20260826090000_add_plan_revisions`, this ships the table, its RLS and its
-- policies in ONE migration, so the table never exists unguarded.

-- CreateEnum
CREATE TYPE "plan_step_kind" AS ENUM ('settle', 'lay', 'author');

-- AlterTable
-- `NOT NULL DEFAULT now()` gives every EXISTING plan "now" — which would make a
-- months-old plan read as active a moment ago. The backfill below corrects it.
ALTER TABLE "plan" ADD COLUMN     "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: the latest thing the plan's own trail recorded, or its creation.
UPDATE "plan" p
SET "last_activity_at" = GREATEST(
  p."created_at",
  COALESCE(
    (SELECT MAX(r."changed_at") FROM "plan_revision" r WHERE r."plan_id" = p."id"),
    p."created_at"
  )
);

-- CreateTable
-- ⚠️ NO `workspace_id` COLUMN, DELIBERATELY — the `plan_revision` decision: the
-- policy JOINS to the parent `plan` and tests THAT row's `workspace_id`.
CREATE TABLE "plan_step" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "session_key" TEXT NOT NULL,
    "kind" "plan_step_kind" NOT NULL,
    "target_ref" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_step_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plan_step_plan_id_idx" ON "plan_step"("plan_id");

-- CreateIndex
-- One row per running session: "replace my step" is an upsert on this key.
CREATE UNIQUE INDEX "plan_step_plan_id_session_key_key" ON "plan_step"("plan_id", "session_key");

-- AddForeignKey
-- Cascades: a plan's steps live exactly as long as the plan.
ALTER TABLE "plan_step" ADD CONSTRAINT "plan_step_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security (the `plan_revision` pattern)
-- ===========================================================================
ALTER TABLE "plan_step" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plan_step" FORCE ROW LEVEL SECURITY;

-- The workspace gate, FOR ALL, joined through the parent plan. WITH CHECK closes
-- "write a step onto somebody ELSE's plan": the plan must itself be visible under
-- the active GUC. An unset GUC hides every row — no context, nothing visible.
CREATE POLICY "plan_step_active_workspace" ON "plan_step"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "plan" p
      WHERE p."id" = "plan_step"."plan_id"
        AND p."workspace_id" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "plan" p
      WHERE p."id" = "plan_step"."plan_id"
        AND p."workspace_id" = current_setting('app.workspace_id', true)
    )
  );

-- The READ-ONLY system arm `plan`, `plan_item` and `plan_revision` carry
-- (20260910230000), so an out-of-band reader under a system context does not
-- read an empty set that looks like "no steps". `FOR SELECT` only: the tenant
-- write refusal is load-bearing (MOTIR-2865).
CREATE POLICY "plan_step_system_read" ON "plan_step"
  FOR SELECT
  USING (current_setting('app.system_admin', true) = 'true');
