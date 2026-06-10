-- CreateEnum
CREATE TYPE "custom_field_type" AS ENUM ('text', 'number', 'date', 'select', 'user');

-- CreateTable
CREATE TABLE "custom_field_definition" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "field_type" "custom_field_type" NOT NULL,
    "description" TEXT,
    "position" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_field_definition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_field_option" (
    "id" TEXT NOT NULL,
    "field_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_field_option_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_field_value" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "field_id" TEXT NOT NULL,
    "value_text" TEXT,
    "value_number" DECIMAL(65,30),
    "value_date" DATE,
    "value_user_id" TEXT,
    "value_option_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_field_value_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "custom_field_definition_project_id_position_idx" ON "custom_field_definition"("project_id", "position");

-- CreateIndex
CREATE INDEX "custom_field_definition_workspace_id_idx" ON "custom_field_definition"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_definition_project_id_key_key" ON "custom_field_definition"("project_id", "key");

-- CreateIndex
CREATE INDEX "custom_field_option_field_id_position_idx" ON "custom_field_option"("field_id", "position");

-- CreateIndex
CREATE INDEX "custom_field_value_field_id_value_option_id_idx" ON "custom_field_value"("field_id", "value_option_id");

-- CreateIndex
CREATE INDEX "custom_field_value_field_id_value_number_idx" ON "custom_field_value"("field_id", "value_number");

-- CreateIndex
CREATE INDEX "custom_field_value_field_id_value_date_idx" ON "custom_field_value"("field_id", "value_date");

-- CreateIndex
CREATE INDEX "custom_field_value_field_id_value_user_id_idx" ON "custom_field_value"("field_id", "value_user_id");

-- CreateIndex
CREATE INDEX "custom_field_value_workspace_id_idx" ON "custom_field_value"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_value_work_item_id_field_id_key" ON "custom_field_value"("work_item_id", "field_id");

-- AddForeignKey
ALTER TABLE "custom_field_definition" ADD CONSTRAINT "custom_field_definition_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_definition" ADD CONSTRAINT "custom_field_definition_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_option" ADD CONSTRAINT "custom_field_option_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "custom_field_definition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_value" ADD CONSTRAINT "custom_field_value_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_value" ADD CONSTRAINT "custom_field_value_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_value" ADD CONSTRAINT "custom_field_value_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "custom_field_definition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_value" ADD CONSTRAINT "custom_field_value_value_user_id_fkey" FOREIGN KEY ("value_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_value" ADD CONSTRAINT "custom_field_value_value_option_id_fkey" FOREIGN KEY ("value_option_id") REFERENCES "custom_field_option"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — custom_field_definition + custom_field_option +
-- custom_field_value (Story 5.3 · Subtask 5.3.1)
--
-- Grants: the workspace RLS migration's `ALTER DEFAULT PRIVILEGES IN SCHEMA
-- public ... TO prodect_app` makes every NEW table created by the `prodect`
-- role auto-grantable to prodect_app, so SELECT/INSERT/UPDATE/DELETE are
-- already granted. No explicit GRANT needed.
-- ===========================================================================
ALTER TABLE "custom_field_definition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "custom_field_definition" FORCE ROW LEVEL SECURITY;

ALTER TABLE "custom_field_option" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "custom_field_option" FORCE ROW LEVEL SECURITY;

ALTER TABLE "custom_field_value" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "custom_field_value" FORCE ROW LEVEL SECURITY;

-- custom_field_definition: pure workspace gate (the workflow_status pattern —
-- explicit non-null workspace_id, always written under an active workspace
-- context). USING governs SELECT/UPDATE/DELETE visibility; WITH CHECK governs
-- the post-image of INSERT/UPDATE so a write can't place (or move) a row into
-- a foreign workspace. current_setting(..., true) is missing_ok: an unset GUC
-- yields NULL → predicate NULL → row hidden (safe failure).
CREATE POLICY "custom_field_definition_active_workspace" ON "custom_field_definition"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

-- custom_field_option: joins through the parent definition (the
-- work_item_revision / comment_mention pattern — the option row carries no
-- workspace_id by design; denormalizing tenancy onto it would let it lie
-- about which workspace it belongs to). The EXISTS subquery resolves via
-- custom_field_definition's PRIMARY KEY — one index lookup per option row
-- touched, no scan. WITH CHECK closes the "insert an option under someone
-- else's field" hole: the referenced definition must itself be visible under
-- the active workspace GUC, or the write is rejected (42501).
CREATE POLICY "custom_field_option_active_workspace" ON "custom_field_option"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "custom_field_definition" d
      WHERE d."id" = "custom_field_option"."field_id"
        AND d."workspace_id" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "custom_field_definition" d
      WHERE d."id" = "custom_field_option"."field_id"
        AND d."workspace_id" = current_setting('app.workspace_id', true)
    )
  );

-- custom_field_value: pure workspace gate — the row carries an explicit
-- non-null workspace_id (the work_item pattern; Epic-6 filter JOINs hit this
-- table directly, so the gate must not itself require another join).
CREATE POLICY "custom_field_value_active_workspace" ON "custom_field_value"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
