-- CONTEXTUAL-PLANNING scope on the plan-change conversation (7.12.3 · MOTIR-909).
--
-- Story 7.30 (MOTIR-1728) gave a project ONE resumable plan-change thread. A
-- contextual planning turn is the SAME conversation substrate anchored at one or
-- more WORK ITEMS ("re-plan this story", "add a subtask under these two"), so the
-- thread has to be addressable by its anchor SET rather than by the project alone
-- — otherwise every work item in a project would share (and clobber) one thread.
--
-- Rather than stand up a parallel chat stack, the shipped table grows a SCOPE:
--
--   * `scope_key`   — the CANONICAL, derived discriminator: the anchor set's
--                     identifiers deduped, sorted and joined by `,`
--                     (lib/planChange/scope.ts). NEVER client-supplied, so two
--                     users naming the same items in a different order resume the
--                     SAME thread instead of forking one. The DEFAULT '' is the
--                     project-wide thread, which is exactly the 7.30 row — every
--                     existing conversation backfills into it with no data move.
--   * `target_keys` — the anchor set itself, as work-item IDENTIFIERS, in that
--                     same canonical order. Stored rather than re-derived because
--                     it is what a resumed thread re-submits as motir-ai's
--                     `context.targetKeys` (7.12.2 · MOTIR-908) and what the panel
--                     labels the thread with. Identifiers, NOT foreign keys — the
--                     `last_job_id` opaque-token posture: deleting an anchor must
--                     not cascade away the conversation about it.
--
-- The UNIQUE widens from `(project_id)` to `(project_id, scope_key)`. The old
-- guarantee is strictly preserved: with `scope_key = ''` there is still exactly
-- ONE project-wide thread per project, so "open the plan-change thread" stays an
-- unambiguous get-or-create whose lost race translates from P2002 to reading the
-- winner's row. What the widening ADDS is one thread per distinct anchor set.
-- Backfill-safe: every pre-existing row takes `scope_key = ''`, and the old index
-- already guaranteed those are unique per project, so the new index cannot fail
-- on existing data.
--
-- No RLS change: this adds COLUMNS to an already-policied table (the 7.30
-- migration installed `plan_change_session`'s workspace policy), and the tenancy
-- column (`workspace_id`) is untouched.

-- DropIndex
DROP INDEX "plan_change_session_project_id_key";

-- AlterTable
ALTER TABLE "plan_change_session" ADD COLUMN     "scope_key" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "target_keys" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE UNIQUE INDEX "plan_change_session_project_id_scope_key_key" ON "plan_change_session"("project_id", "scope_key");
