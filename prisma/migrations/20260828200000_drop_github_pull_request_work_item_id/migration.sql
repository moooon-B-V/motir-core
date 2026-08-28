-- ===========================================================================
-- CONTRACT — drop `github_pull_request.work_item_id` (MOTIR-3757 ·
-- `docs/decisions/delivery-reader-migration.md` §6).
--
-- `work_item_delivery` is now the ONLY association between a pull request and a
-- work item. The two EXPAND cards (MOTIR-3721, MOTIR-3756) moved every reader off
-- this column; this migration removes it, and the two WRITERS
-- (`githubPullRequestRepository.setWorkItemLink`, `UpsertGithubPullRequestInput.workItemId`)
-- retire in the same pull request.
--
-- `linked_manually` is NOT dropped. Nothing has read it for control flow since
-- MOTIR-3674 retired the branch/title parse it made sticky, but it is the
-- provenance of the rows already written and retiring it is its own decision.
--
-- ⚠️ A DROP IS NOT REVERSIBLE BY A CODE REVERT. The EXPAND migration
-- (20260827094500) already backfilled every non-null `work_item_id` into
-- `work_item_delivery` (its pass 1), and every write path that has set the column
-- since then writes a delivery row in the same transaction. The re-run below is
-- therefore expected to insert ZERO rows — it is here because "expected zero" is
-- an argument and this is the last moment at which the column can be read. It is
-- the SAME statement as pass 1, so it is idempotent by the unique index.
--
-- RLS: `work_item_delivery` is FORCE RLS and its policy admits
-- `app.system_admin = 'true'` (20260828120000). The migration role is subject to
-- the policy like any other, so the flag is set for this transaction rather than
-- the policy being weakened. `SET LOCAL` unsets it at commit.
-- ===========================================================================

SET LOCAL "app.system_admin" = 'true';

DO $$
DECLARE
  rescued integer;
BEGIN
  INSERT INTO "work_item_delivery" ("id", "workspace_id", "work_item_id", "github_pull_request_id", "repo_id")
  SELECT gen_random_uuid()::text,
         w."workspaceId",
         w."id",
         pr."id",
         pr."repo_id"
  FROM "github_pull_request" pr
  JOIN "work_item" w ON w."id" = pr."work_item_id"
  JOIN "github_repo" gr ON gr."id" = pr."repo_id" AND gr."workspace_id" = w."workspaceId"
  ON CONFLICT ("work_item_id", "github_pull_request_id") DO NOTHING;

  GET DIAGNOSTICS rescued = ROW_COUNT;

  -- A NON-ZERO count here is a FINDING, not a success: it means a write path set
  -- the column without writing a delivery row after 20260827094500, and the pull
  -- request that did it should be found. Emitted as a NOTICE so it lands in the
  -- `migrate deploy` log rather than being a number only one laptop ever saw.
  RAISE NOTICE 'MOTIR-3757: % stored link(s) had no work_item_delivery row and were carried over before the drop (expected 0)', rescued;
END
$$;

-- DropForeignKey
ALTER TABLE "github_pull_request" DROP CONSTRAINT "github_pull_request_work_item_id_fkey";

-- DropIndex
DROP INDEX "github_pull_request_work_item_id_idx";

-- AlterTable
ALTER TABLE "github_pull_request" DROP COLUMN "work_item_id";
