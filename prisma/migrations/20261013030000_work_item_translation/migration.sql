-- Kept work-item translations (Story MOTIR-7735 · MOTIR-8114). EXPAND-ONLY: one
-- new table, nothing existing is altered. One row per field, per revision of
-- that field's text (`source_hash` = sha256 hex of the text), per target
-- language, shared across the organisation (no reader in the key).

-- CreateTable
CREATE TABLE "work_item_translation" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "field_ref" TEXT NOT NULL,
    "source_hash" TEXT NOT NULL,
    "target_language" TEXT NOT NULL,
    "translated_text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_translation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "work_item_translation_work_item_id_target_language_idx" ON "work_item_translation"("work_item_id", "target_language");

-- CreateIndex
CREATE INDEX "work_item_translation_organization_id_idx" ON "work_item_translation"("organization_id");

-- CreateIndex
CREATE INDEX "work_item_translation_workspace_id_idx" ON "work_item_translation"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "work_item_translation_work_item_id_field_ref_source_hash_ta_key" ON "work_item_translation"("work_item_id", "field_ref", "source_hash", "target_language");

-- AddForeignKey
ALTER TABLE "work_item_translation" ADD CONSTRAINT "work_item_translation_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_translation" ADD CONSTRAINT "work_item_translation_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_translation" ADD CONSTRAINT "work_item_translation_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Row-level security — work_item_translation
-- ===========================================================================
-- The gate is the row's OWN `workspace_id`, not a join through `work_item` —
-- RLS does not traverse foreign keys. This is `work_item_todo_active_workspace`
-- byte for byte, and for the same reason: every read and write of a kept
-- translation is made by a person reading one card inside one workspace (the
-- translation door, MOTIR-8120), so the arm every work-item read already binds
-- is the arm this table needs. A reader in another organisation is in another
-- workspace, so the row is invisible to them and a write naming it fails the
-- WITH CHECK (42501).
--
-- NO `app.system_admin` or `app.organization_id` arm, deliberately: there is
-- no caller without a workspace context to admit, and an arm nobody needs is a
-- hole nobody is watching. `organization_id` is carried for the cascade when an
-- organisation is erased and for the organisation-wide usage reads, not as a
-- policy arm.
--
-- `current_setting(..., true)` is missing_ok, so an unset GUC yields NULL and
-- the row is hidden — no context means nothing visible.
--
-- The workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO prodect_app`
-- auto-grants on every new table created by the owner role, so no explicit
-- GRANT is needed (same as work_item_todo).
ALTER TABLE "work_item_translation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "work_item_translation" FORCE ROW LEVEL SECURITY;

CREATE POLICY "work_item_translation_active_workspace" ON "work_item_translation"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
