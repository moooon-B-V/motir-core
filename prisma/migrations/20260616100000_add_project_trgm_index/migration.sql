-- Story 6.13 · Subtask 6.13.3 — the project-square directory search
-- (name/description ILIKE) must not table-scan across a cross-org directory of
-- potentially thousands of public projects (finding #57). pg_trgm trigram GIN
-- serves ILIKE '%…%' on either column of the multicolumn index. The pg_trgm
-- extension is already created by the 6.1.1 work-item trgm migration; the guard
-- keeps this idempotent on a DB where it is somehow absent.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX "project_name_public_overview_md_idx" ON "project" USING GIN ("name" gin_trgm_ops, "public_overview_md" gin_trgm_ops);
