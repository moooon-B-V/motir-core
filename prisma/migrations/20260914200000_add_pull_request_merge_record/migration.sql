-- THE PULL REQUEST'S MERGE RECORD (Story MOTIR-4882 · MOTIR-5520;
-- `docs/decisions/approval-gates.md` §4 second amendment, decision 9, and §7a).
--
-- Two nullable columns on `github_pull_request` saying WHO or WHAT authorised a merge
-- Motir performed (`gate` | `auto_mode`) and WHAT it produced (the merge commit SHA,
-- or `queue:<entryId>` for an enqueue). Every existing row reads NULL on both, which
-- means "not merged by Motir" — true of all of them.
--
-- Additive and nullable only, so it needs no expand/contract phasing: no reader of
-- this table is disturbed by a column it does not select. It deliberately touches
-- nothing on `approval_gate`, whose `outcome_ref` is the status key a decision
-- applied and must never carry a merge SHA.
--
-- Idempotent, so a re-run of `migrate deploy` over a half-applied database is safe.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'merge_authority') THEN
    CREATE TYPE "merge_authority" AS ENUM ('gate', 'auto_mode');
  END IF;
END
$$;

ALTER TABLE "github_pull_request" ADD COLUMN IF NOT EXISTS "merge_authority" "merge_authority";
ALTER TABLE "github_pull_request" ADD COLUMN IF NOT EXISTS "merge_outcome_ref" TEXT;
