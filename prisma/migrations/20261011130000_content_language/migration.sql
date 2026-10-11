-- Content language (Story MOTIR-7731 · MOTIR-8092). EXPAND-ONLY: every change
-- is additive. `organization.content_language` is added with its `en` default,
-- which backfills every existing organisation; the five per-field language
-- columns are added NULLABLE with NO default and NO backfill, so every existing
-- work item and to-do reads "no language recorded" (NULL), never `en`.


-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "content_language" TEXT NOT NULL DEFAULT 'en';

-- AlterTable
ALTER TABLE "work_item" ADD COLUMN     "description_language" TEXT,
ADD COLUMN     "explanation_language" TEXT,
ADD COLUMN     "title_language" TEXT;

-- AlterTable
ALTER TABLE "work_item_todo" ADD COLUMN     "notes_language" TEXT,
ADD COLUMN     "text_language" TEXT;

-- CreateTable
CREATE TABLE "organization_content_language_change" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "changed_by_user_id" TEXT,
    "from_language" TEXT NOT NULL,
    "to_language" TEXT NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_content_language_change_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "organization_content_language_change_organization_id_change_idx" ON "organization_content_language_change"("organization_id", "changed_at");

-- CreateIndex
CREATE INDEX "organization_content_language_change_changed_by_user_id_idx" ON "organization_content_language_change"("changed_by_user_id");

-- AddForeignKey
ALTER TABLE "organization_content_language_change" ADD CONSTRAINT "organization_content_language_change_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_content_language_change" ADD CONSTRAINT "organization_content_language_change_changed_by_user_id_fkey" FOREIGN KEY ("changed_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- RLS — the organisation-scoped shape `organization_deletion_request` uses: a
-- row is visible to a transaction bound to its organisation, or to the system
-- arm. Written only through `withOrgContext` (MOTIR-8094); removed by the
-- organisation's FK cascade, which RLS does not filter.
ALTER TABLE "organization_content_language_change" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_content_language_change" FORCE ROW LEVEL SECURITY;

CREATE POLICY "organization_content_language_change_org_or_system" ON "organization_content_language_change"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "organization_id" = current_setting('app.organization_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "organization_id" = current_setting('app.organization_id', true)
  );
