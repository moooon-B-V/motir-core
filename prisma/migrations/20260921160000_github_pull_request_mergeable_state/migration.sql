-- THE HOST'S MERGEABILITY SURVIVES THE READ (MOTIR-5913, for bug MOTIR-5907).
--
-- Motir decided whether to ask "approve and merge?" from CI and draft-ness alone,
-- and learned about a conflict only from the refused merge after the press. These
-- two columns hold GitHub's `mergeable_state` and the head it was read at, so the
-- merge-candidate predicate, CI promotion and `motir fix` can read the host's
-- answer before anybody is asked.
--
-- NULLABLE, NO DEFAULT, NO BACKFILL — the same shape `draft`, `base_ref` and
-- `merged_at` take on this table. A row that has never been asked genuinely does
-- not know, and null is read as "not known", never as "conflicted".
ALTER TABLE "github_pull_request"
  ADD COLUMN "mergeable_state" TEXT,
  ADD COLUMN "mergeable_state_head_sha" TEXT;
