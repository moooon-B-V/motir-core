-- ============================================================
-- THE DECISION DOCUMENT AT THE HEAD (Story MOTIR-4907 · MOTIR-5674).
-- ============================================================
-- `docs/decisions/approval-gates.md` §8's FIFTH AMENDMENT, clause 7: which
-- `docs/decisions/*.md` file a decision card's pull request adds or modifies is
-- known only to the host, and a gate transaction may not call the host. So the
-- file's IDENTITY — its path and git blob sha at the head — is captured onto the
-- pull-request mirror when the head is observed, and read back from here.
--
-- ⚠️ NOT A DOCUMENT STORE. Motir keeps no copy of any decision document (the
-- requester decision the amendment records); these columns name a file on the
-- host, they do not hold it.
--
-- ⚠️ AND NOT `changed_paths`, which stays the MERGE's file list (MOTIR-2922).
--
-- EXPAND-ONLY: one new enum and four NULLABLE columns, no default, no backfill.
-- A row with no capture is null, which is exactly "never observed" — nothing
-- written before this migration was ever a decision card's capture.

CREATE TYPE "decision_doc_outcome" AS ENUM ('one', 'none', 'several', 'unreadable');

ALTER TABLE "github_pull_request"
  ADD COLUMN "decision_doc_outcome" "decision_doc_outcome",
  ADD COLUMN "decision_doc_path" TEXT,
  ADD COLUMN "decision_doc_blob_sha" TEXT,
  ADD COLUMN "decision_doc_head_sha" TEXT;
