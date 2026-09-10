-- DRAFT-NESS SURVIVES THE DELIVERY (MOTIR-5002).
--
-- `NormalizedChangeRequest.draft` reached the status machine on MOTIR-4968 and
-- then evaporated: the mirror row modelled it nowhere, so the LINK door — which
-- has no payload and synthesizes a change request from this row — had to pin
-- `draft: false` and assert `implemented` about a pull request explicitly not
-- offered for review.
--
-- NULLABLE, NO DEFAULT, NO BACKFILL — the same shape `base_ref` and `merged_at`
-- take on this table, and for the same reason: a row mirrored before this column
-- existed genuinely does not know its answer, and null is that answer rather than
-- a guess. The two guesses are NOT symmetric here. A `DEFAULT false` would say
-- "not a draft" about every open pull request in the estate, which is exactly the
-- population most likely to be a draft — a parent run's pull request is a draft
-- until its last child lands — and would re-assert the defect this column exists
-- to remove. So the one reader (`resyncLinkedPullRequest`) DECLINES on null, and
-- the next delivery fills it in.
ALTER TABLE "github_pull_request"
  ADD COLUMN "draft" BOOLEAN;
