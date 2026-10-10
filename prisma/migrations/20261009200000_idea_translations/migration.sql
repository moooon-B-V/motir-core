-- PER-LOCALE IDEA TEXT (Story MOTIR-7772 · MOTIR-7773).
--
-- The idea store can hold an idea's text, each evidence claim and each tag label
-- in the ten non-English locales, field by field, beside the English the base
-- rows already require. EXPAND-ONLY: a new enum and three new tables; no
-- existing column moves and no existing row changes, so one deploy is safe.
-- `idea.updated_at` already exists (`20261007100000_idea_store`), so nothing is
-- added to `idea`.
--
-- ── ROW-LEVEL SECURITY ─────────────────────────────────────────────────────
-- The idea store's own posture, copied from `20261007100000_idea_store`:
--   · READ is unconditional — a translation is published content exactly as the
--     English it translates is, and the public reads run with nothing bound.
--   · WRITE is `app.platform_staff` only, inside `withPlatformWrite`.
-- ONE `FOR ALL` write arm per table. Grants: the add_workspace_rls migration's
-- ALTER DEFAULT PRIVILEGES covers every new table.

-- CreateEnum
CREATE TYPE "idea_translation_locale" AS ENUM ('zh', 'ja', 'ko', 'de', 'fr', 'es', 'it', 'nl', 'pl', 'pt');

-- CreateTable
CREATE TABLE "idea_translation" (
    "idea_id" TEXT NOT NULL,
    "locale" "idea_translation_locale" NOT NULL,
    "title" TEXT,
    "pitch" TEXT,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "gap" TEXT,
    "why_now" TEXT,
    "why_motir" TEXT,
    "who_else" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idea_translation_pkey" PRIMARY KEY ("idea_id","locale")
);

-- CreateTable
CREATE TABLE "idea_evidence_translation" (
    "evidence_id" TEXT NOT NULL,
    "locale" "idea_translation_locale" NOT NULL,
    "claim" TEXT NOT NULL,

    CONSTRAINT "idea_evidence_translation_pkey" PRIMARY KEY ("evidence_id","locale")
);

-- CreateTable
CREATE TABLE "idea_tag_translation" (
    "tag_id" TEXT NOT NULL,
    "locale" "idea_translation_locale" NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "idea_tag_translation_pkey" PRIMARY KEY ("tag_id","locale")
);

-- AddForeignKey
ALTER TABLE "idea_translation" ADD CONSTRAINT "idea_translation_idea_id_fkey" FOREIGN KEY ("idea_id") REFERENCES "idea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea_evidence_translation" ADD CONSTRAINT "idea_evidence_translation_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "idea_evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea_tag_translation" ADD CONSTRAINT "idea_tag_translation_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "idea_tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — idea_translation
-- ===========================================================================
ALTER TABLE "idea_translation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idea_translation" FORCE ROW LEVEL SECURITY;

CREATE POLICY "idea_translation_read" ON "idea_translation"
  FOR SELECT
  USING (true);

CREATE POLICY "idea_translation_platform_staff" ON "idea_translation"
  FOR ALL
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true')
  WITH CHECK (coalesce(current_setting('app.platform_staff', true), '') = 'true');

-- ===========================================================================
-- Row-level security — idea_evidence_translation
-- ===========================================================================
ALTER TABLE "idea_evidence_translation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idea_evidence_translation" FORCE ROW LEVEL SECURITY;

CREATE POLICY "idea_evidence_translation_read" ON "idea_evidence_translation"
  FOR SELECT
  USING (true);

CREATE POLICY "idea_evidence_translation_platform_staff" ON "idea_evidence_translation"
  FOR ALL
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true')
  WITH CHECK (coalesce(current_setting('app.platform_staff', true), '') = 'true');

-- ===========================================================================
-- Row-level security — idea_tag_translation
-- ===========================================================================
ALTER TABLE "idea_tag_translation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idea_tag_translation" FORCE ROW LEVEL SECURITY;

CREATE POLICY "idea_tag_translation_read" ON "idea_tag_translation"
  FOR SELECT
  USING (true);

CREATE POLICY "idea_tag_translation_platform_staff" ON "idea_tag_translation"
  FOR ALL
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true')
  WITH CHECK (coalesce(current_setting('app.platform_staff', true), '') = 'true');
