-- ============================================================
-- EVERY DECISION DOCUMENT THE HEAD WRITES (Story MOTIR-4907 · MOTIR-5678).
-- ============================================================
-- The capture (20260919140000) records ONE document's path, for outcome `one`.
-- When a head writes several, the decision port names them so a reviewer can see
-- what has to be reduced to one (`design/github/design-notes.md` §27, Panel 3b) —
-- and the host may not be called to find out, for the same reason the capture
-- exists at all. So the capture keeps the whole list.
--
-- ⚠️ STILL NOT A DOCUMENT STORE: file paths on the host, never their contents.
--
-- EXPAND-ONLY: one column defaulting to empty, no backfill. A row captured before
-- this migration reads empty, which the subject treats as "name the one `path`".

ALTER TABLE "github_pull_request" ADD COLUMN "decision_doc_paths" TEXT[] DEFAULT ARRAY[]::TEXT[];
