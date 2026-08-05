-- ===========================================================================
-- Clear the FALSE `manual` implementation stamp from CANCELLED work items
-- (MOTIR-2221)
-- ===========================================================================
-- WHY THIS EXISTS. `workItemsService.applyStatusTransition` opened its terminal
-- branch on `target.category === 'done'`, and the default workflow files
-- `cancelled` under `category: 'done'` alongside `done`
-- (lib/workflows/defaultWorkflow.ts). So every human/manual work item moved to
-- CANCELLED was stamped `implementationSource = 'manual'` — an assertion that a
-- person implemented work that was, by the very act of cancelling it, abandoned.
-- The guard shipped alongside this migration keys that stamp on the status KEY
-- instead, so no new row can acquire the false claim. This clears the rows the
-- unguarded lane already wrote.
--
-- WHY A MIGRATION AND NOT A BACKFILL RE-RUN. The offline classifier
-- (`lib/workItems/provenanceBackfill.ts`) already excludes `cancelled` and
-- always did — but `classifyImplementationSource` is null-guarded ("non-null
-- means HANDS OFF, whatever the rules say"), so once this lane wrote `manual`,
-- no number of `pnpm db:backfill:provenance` runs will ever undo it. The repair
-- has to be deliberate. `prisma migrate deploy` runs on every release
-- (.github/workflows + the Vercel build step), so this self-applies with no
-- operator step — the shape mistake #100/#101 in motir-meta/notes.html
-- prescribes for deployed-data repair.
--
-- THE PREDICATE IS THE GUARD — four parts, ALL required, so this clears only
-- rows whose `manual` stamp could not have come from anywhere but the bug:
--
--   1. `status = 'cancelled'`     — the abandoned terminal status. `cancelled`
--      is a status KEY, never a `status_category` label (that enum has exactly
--      three: todo | in_progress | done), so this compares the KEY column. A
--      `ws."category" = 'cancelled'` comparison raises 22P02 and has broken a
--      shipped query here before (MOTIR-1744 / notes.html #162).
--   2. `"implementationSource" = 'manual'` — only the value this bug writes.
--      A `byok` / `hosted` stamp on a cancelled item is a real agent report
--      that arrived at `in_review` and is left alone.
--   3. `"sessionBranch" IS NULL`  — no integration lineage. A cancelled item
--      still carrying a branch was genuinely worked on; its stamp is evidence,
--      not noise. (The lane clears `sessionBranch` on reaching a done-category
--      status, so on a cancelled row this is normally NULL — which is why the
--      remaining two parts carry most of the discrimination.)
--   4. no `github_pull_request` row points at it — the MOTIR-1758 backfill
--      treats a linked PR as `byok` evidence; a cancelled item with one was
--      implemented, whatever became of it afterwards.
--
-- NOT TENANT-GUARDED, deliberately. Unlike `20260701130000_ensure_planner_bug_home`
-- (which INSERTS moooon-specific rows and so must key on the meta tenant), this
-- writes nothing new and INVENTS nothing: it removes a claim the code should
-- never have made, on any deployment that ran the buggy lane — including a
-- self-hosted one. On a fresh / CI / preview database the predicate matches zero
-- rows and the statement is a no-op.
--
-- IDEMPOTENT BY CONSTRUCTION. The write sets the column to NULL, which drops
-- every matched row out of part 2 of its own predicate — so a second apply
-- affects zero rows. (`migrate deploy` runs a migration exactly once per
-- database anyway; this holds regardless, and is what the test asserts.)
--
-- Reports the blast radius as a NOTICE so the release log carries the number
-- rather than an assumption. Covered by
-- tests/integration/migrations/clear-cancelled-manual-provenance.test.ts.
-- ===========================================================================
DO $$
DECLARE
  cleared_rows bigint;
BEGIN
  UPDATE "work_item" AS wi
     SET "implementationSource" = NULL
   WHERE wi."status" = 'cancelled'
     AND wi."implementationSource" = 'manual'
     AND wi."sessionBranch" IS NULL
     AND NOT EXISTS (
       SELECT 1
         FROM "github_pull_request" pr
        WHERE pr."work_item_id" = wi."id"
     );

  GET DIAGNOSTICS cleared_rows = ROW_COUNT;
  RAISE NOTICE 'MOTIR-2221: cleared a false manual implementation stamp from % cancelled work_item row(s)', cleared_rows;
END
$$;
