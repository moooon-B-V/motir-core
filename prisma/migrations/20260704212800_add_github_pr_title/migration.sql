-- MOTIR-1579: persist the PR title at webhook ingestion so the work-item
-- Development surface can render it (rows ingested earlier stay NULL and
-- display their head_ref instead). Plain nullable column — no FK, no index.
ALTER TABLE "github_pull_request" ADD COLUMN "title" TEXT;
