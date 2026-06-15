-- Story 6.12 · Subtask 6.12.6 — the public-request comment split
-- (docs/decisions/public-projects.md §4). A public-request comment (authored on
-- a public project through the `canCommentPublicRequest` grant) is marked
-- `is_public = true`; the work item's INTERNAL discussion (every Story 5.1
-- comment) stays `false`. The 6.12.4 public projection returns ONLY `is_public`
-- comments for a request and never the internal thread — so the distinction is a
-- data fact, not a UI convention. Existing rows default to internal (`false`),
-- which is correct: no public-request comment exists before this subtask.
ALTER TABLE "comment" ADD COLUMN "is_public" BOOLEAN NOT NULL DEFAULT false;
