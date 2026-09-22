-- Story MOTIR-6067 · MOTIR-6074 (ADR `approval-gates.md` §10b): a GitHub review's
-- BODY is captured, so a `changes_requested` synced from it carries its reason.
-- Expand-only: a nullable column, no backfill — a review recorded before this
-- migration simply has no captured text.
ALTER TABLE "github_pull_request_review" ADD COLUMN "body" TEXT;
