-- The planner's narration, kept as history (Story MOTIR-8060 · Subtask MOTIR-8062).
--
-- Two tables, both plan-scoped like `plan_step` and shipped with their RLS in
-- this one migration so neither exists unguarded:
--   * `plan_narration` — every plain-language sentence a planner session wrote,
--     APPEND-ONLY, ordered by a gapless per-plan `seq`;
--   * `plan_narration_session` — each session's step words (kind, target ref,
--     target title at report time), upserted on a step report and NEVER touched
--     by `end`, so a finished session's group still names its step.
-- Neither has an FK to `plan_step` (it is deleted at `end`), and neither has a
-- `workspace_id`: the policies JOIN to the parent `plan`, the `plan_step` shape.

-- CreateTable
CREATE TABLE "plan_narration" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "session_key" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_narration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_narration_session" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "session_key" TEXT NOT NULL,
    "step_kind" "plan_step_kind" NOT NULL,
    "target_ref" TEXT,
    "target_title" TEXT,
    "first_reported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_narration_session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plan_narration_plan_id_session_key_idx" ON "plan_narration"("plan_id", "session_key");

-- CreateIndex
CREATE UNIQUE INDEX "plan_narration_plan_id_seq_key" ON "plan_narration"("plan_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "plan_narration_session_plan_id_session_key_key" ON "plan_narration_session"("plan_id", "session_key");

-- AddForeignKey
ALTER TABLE "plan_narration" ADD CONSTRAINT "plan_narration_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_narration_session" ADD CONSTRAINT "plan_narration_session_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security (the `plan_step` pattern, copied)
-- ===========================================================================
ALTER TABLE "plan_narration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plan_narration" FORCE ROW LEVEL SECURITY;
ALTER TABLE "plan_narration_session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plan_narration_session" FORCE ROW LEVEL SECURITY;

-- The workspace gate, FOR ALL, joined through the parent plan. WITH CHECK closes
-- "write narration onto somebody ELSE's plan". An unset GUC hides every row.
CREATE POLICY "plan_narration_active_workspace" ON "plan_narration"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "plan" p
      WHERE p."id" = "plan_narration"."plan_id"
        AND p."workspace_id" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "plan" p
      WHERE p."id" = "plan_narration"."plan_id"
        AND p."workspace_id" = current_setting('app.workspace_id', true)
    )
  );

CREATE POLICY "plan_narration_session_active_workspace" ON "plan_narration_session"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "plan" p
      WHERE p."id" = "plan_narration_session"."plan_id"
        AND p."workspace_id" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "plan" p
      WHERE p."id" = "plan_narration_session"."plan_id"
        AND p."workspace_id" = current_setting('app.workspace_id', true)
    )
  );

-- The READ-ONLY system arm `plan_step` carries. `FOR SELECT` only.
CREATE POLICY "plan_narration_system_read" ON "plan_narration"
  FOR SELECT
  USING (current_setting('app.system_admin', true) = 'true');

CREATE POLICY "plan_narration_session_system_read" ON "plan_narration_session"
  FOR SELECT
  USING (current_setting('app.system_admin', true) = 'true');
