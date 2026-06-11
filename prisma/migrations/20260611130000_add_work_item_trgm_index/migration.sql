-- Story 6.1 · Subtask 6.1.1 — the filter builder's free-text contains-match
-- (title/description ILIKE) must not table-scan at real-product scale
-- (finding #57). pg_trgm trigram GIN serves ILIKE '%…%' on either column of
-- the multicolumn index. Neon (prod) and the dev/CI Postgres both ship the
-- pg_trgm extension.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX "work_item_title_descriptionMd_idx" ON "work_item" USING GIN ("title" gin_trgm_ops, "descriptionMd" gin_trgm_ops);
