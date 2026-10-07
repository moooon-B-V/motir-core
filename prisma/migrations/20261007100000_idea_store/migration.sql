-- The IDEA STORE (Story MOTIR-7662 · MOTIR-7670).
--
-- Ideas with their ordered evidence, a curated tag vocabulary joined
-- many-to-many, the research-run log the `motir-ideas` skill writes, and `idea`
-- as a target the platform audit log can name. EXPAND-ONLY: every table, type
-- and column is new, so one deploy is safe. The 15 ideas on today's page are
-- seeded by the NEXT migration (MOTIR-7674) — the enum value added here cannot
-- be used inside the transaction that adds it, and the seed does not need it.
--
-- ── ROW-LEVEL SECURITY ─────────────────────────────────────────────────────
-- The `platform_run_model` posture: no TENANT arm, because no tenant owns or
-- edits these rows.
--   · READ is unconditional. The store is platform content whose active rows are
--     published to anonymous readers by design, and nothing in a retired row or
--     a research run is tenant data. The public/staff split is the SERVICE's
--     (the public repository filters `status = 'active'` on every query) — a
--     policy predicate here would only reproduce it, and would hide retired
--     rows from the staff reads that must list them.
--   · WRITE is `app.platform_staff` only: every write runs inside
--     `withPlatformRead`, which appends the audit row in the same transaction.
-- ONE `FOR ALL` write arm per table, so UPDATE/DELETE have a permissive policy
-- (`tests/tenant-root-creation-rls.test.ts`). Grants: the add_workspace_rls
-- migration's ALTER DEFAULT PRIVILEGES covers every new table.
-- CreateEnum
CREATE TYPE "idea_kind" AS ENUM ('motir_buys', 'direction');

-- CreateEnum
CREATE TYPE "idea_status" AS ENUM ('active', 'retired');

-- CreateEnum
CREATE TYPE "idea_category" AS ENUM ('legal', 'finance', 'security_compliance', 'customer_support', 'localization', 'growth_marketing', 'sales', 'people_hr', 'operations', 'engineering', 'ecommerce', 'healthcare', 'education', 'financial_services', 'real_estate', 'logistics', 'construction', 'agriculture', 'pets', 'family_care', 'public_sector', 'personal_growth', 'personal_finance', 'health_wellness', 'ai_infrastructure');

-- AlterEnum
ALTER TYPE "platform_audit_target_kind" ADD VALUE 'idea';

-- CreateTable
CREATE TABLE "idea" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "pitch" TEXT NOT NULL,
    "kind" "idea_kind" NOT NULL,
    "category" "idea_category" NOT NULL,
    "capabilities" TEXT[],
    "gap" TEXT,
    "why_now" TEXT,
    "why_motir" TEXT,
    "who_else" TEXT,
    "status" "idea_status" NOT NULL DEFAULT 'active',
    "retired_reason" TEXT,
    "retired_at" TIMESTAMP(3),
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_reviewed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idea_evidence" (
    "id" TEXT NOT NULL,
    "idea_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "claim" TEXT NOT NULL,
    "source_name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "source_date" DATE,

    CONSTRAINT "idea_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idea_tag" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idea_tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idea_tag_assignment" (
    "idea_id" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,

    CONSTRAINT "idea_tag_assignment_pkey" PRIMARY KEY ("idea_id","tag_id")
);

-- CreateTable
CREATE TABLE "idea_research_run" (
    "id" TEXT NOT NULL,
    "ran_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_user_id" TEXT NOT NULL,
    "areas_covered" TEXT[],
    "added_count" INTEGER NOT NULL,
    "retired_count" INTEGER NOT NULL,
    "report_md" TEXT NOT NULL,

    CONSTRAINT "idea_research_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "idea_slug_key" ON "idea"("slug");

-- CreateIndex
CREATE INDEX "idea_status_category_idx" ON "idea"("status", "category");

-- CreateIndex
CREATE INDEX "idea_status_kind_idx" ON "idea"("status", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "idea_evidence_idea_id_position_key" ON "idea_evidence"("idea_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "idea_tag_slug_key" ON "idea_tag"("slug");

-- CreateIndex
CREATE INDEX "idea_tag_assignment_tag_id_idx" ON "idea_tag_assignment"("tag_id");

-- CreateIndex
CREATE INDEX "idea_research_run_ran_at_idx" ON "idea_research_run"("ran_at");

-- CreateIndex
CREATE INDEX "idea_research_run_actor_user_id_idx" ON "idea_research_run"("actor_user_id");

-- AddForeignKey
ALTER TABLE "idea_evidence" ADD CONSTRAINT "idea_evidence_idea_id_fkey" FOREIGN KEY ("idea_id") REFERENCES "idea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea_tag_assignment" ADD CONSTRAINT "idea_tag_assignment_idea_id_fkey" FOREIGN KEY ("idea_id") REFERENCES "idea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea_tag_assignment" ADD CONSTRAINT "idea_tag_assignment_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "idea_tag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea_research_run" ADD CONSTRAINT "idea_research_run_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A retired idea carries its reason and its moment; an active one carries
-- neither. Both directions, so a retire can never lose its reason and an
-- un-retire (a correction) can never keep a stale one.
ALTER TABLE "idea" ADD CONSTRAINT "idea_retired_fields_check" CHECK (
  (status = 'retired' AND retired_reason IS NOT NULL AND retired_at IS NOT NULL)
  OR (status = 'active' AND retired_reason IS NULL AND retired_at IS NULL)
);

-- ===========================================================================
-- Row-level security — idea
-- ===========================================================================
ALTER TABLE "idea" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idea" FORCE ROW LEVEL SECURITY;

CREATE POLICY "idea_read" ON "idea"
  FOR SELECT
  USING (true);

CREATE POLICY "idea_platform_staff" ON "idea"
  FOR ALL
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true')
  WITH CHECK (coalesce(current_setting('app.platform_staff', true), '') = 'true');

-- ===========================================================================
-- Row-level security — idea_evidence
-- ===========================================================================
ALTER TABLE "idea_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idea_evidence" FORCE ROW LEVEL SECURITY;

CREATE POLICY "idea_evidence_read" ON "idea_evidence"
  FOR SELECT
  USING (true);

CREATE POLICY "idea_evidence_platform_staff" ON "idea_evidence"
  FOR ALL
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true')
  WITH CHECK (coalesce(current_setting('app.platform_staff', true), '') = 'true');

-- ===========================================================================
-- Row-level security — idea_tag
-- ===========================================================================
ALTER TABLE "idea_tag" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idea_tag" FORCE ROW LEVEL SECURITY;

CREATE POLICY "idea_tag_read" ON "idea_tag"
  FOR SELECT
  USING (true);

CREATE POLICY "idea_tag_platform_staff" ON "idea_tag"
  FOR ALL
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true')
  WITH CHECK (coalesce(current_setting('app.platform_staff', true), '') = 'true');

-- ===========================================================================
-- Row-level security — idea_tag_assignment
-- ===========================================================================
ALTER TABLE "idea_tag_assignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idea_tag_assignment" FORCE ROW LEVEL SECURITY;

CREATE POLICY "idea_tag_assignment_read" ON "idea_tag_assignment"
  FOR SELECT
  USING (true);

CREATE POLICY "idea_tag_assignment_platform_staff" ON "idea_tag_assignment"
  FOR ALL
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true')
  WITH CHECK (coalesce(current_setting('app.platform_staff', true), '') = 'true');

-- ===========================================================================
-- Row-level security — idea_research_run
-- ===========================================================================
ALTER TABLE "idea_research_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idea_research_run" FORCE ROW LEVEL SECURITY;

CREATE POLICY "idea_research_run_read" ON "idea_research_run"
  FOR SELECT
  USING (true);

CREATE POLICY "idea_research_run_platform_staff" ON "idea_research_run"
  FOR ALL
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true')
  WITH CHECK (coalesce(current_setting('app.platform_staff', true), '') = 'true');
