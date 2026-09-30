-- THE PULL REQUEST'S OWN HEAD (MOTIR-7005).
--
-- Motir stored no pull-request head. Every reader derived "the current head" from
-- the newest check-run commit, which holds only until a push produces no CI — and
-- GitHub guarantees exactly that for a pull request that conflicts with its base
-- (no merge ref, so no `pull_request` workflow runs). The check rows then stay at
-- the old green commit, and the approve-to-merge question was asked, withdrawn and
-- asked again every reconcile tick, over a commit the pull request had left.
--
-- This column is the host's head as of the last delivery or host read. The
-- conflict check, the merge-candidate predicate, the CI promotion and the gate's
-- member version all read it through `lib/github/pullRequestHead.ts`.
--
-- NULLABLE, NO DEFAULT, NO BACKFILL — the shape `draft`, `base_ref` and
-- `mergeable_state` take on this table. A row nobody has told its head reads as
-- UNKNOWN, and the readers fall back to the check rows' head, which is what they
-- did before this column. The next `pull_request` delivery or reconcile read fills
-- it in, and the reconcile sweep reads every open pull request delivering a live card.
ALTER TABLE "github_pull_request"
  ADD COLUMN "head_sha" TEXT;
