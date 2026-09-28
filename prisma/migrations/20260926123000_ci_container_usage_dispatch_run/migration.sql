-- Story MOTIR-683 · Subtask MOTIR-6448: a hosted run's machine time is keyed to its
-- dispatch run (`docs/decisions/hosted-agent-run.md` §1 — `DispatchRun.id` is the one
-- id a hosted run carries everywhere, the container meter row included).
--
-- ADDITIVE, nullable, no backfill: every existing row is a CI runner or an index
-- container, which serve no run, so NULL is the correct and complete answer for
-- them, and the still-serving build neither reads nor names the column (the
-- ordinary migrate-then-serve order is safe). RLS is unchanged:
-- `ci_container_usage` keeps its workspace-or-system policy, and the column adds no
-- predicate.
--
-- `ON DELETE SET NULL`: the record that Motir paid for a container must survive a
-- deleted run, for the same reason `project_id` is SET NULL.

-- AlterTable
ALTER TABLE "ci_container_usage" ADD COLUMN     "dispatch_run_id" TEXT;

-- CreateIndex
CREATE INDEX "ci_container_usage_dispatch_run_id_idx" ON "ci_container_usage"("dispatch_run_id");

-- AddForeignKey
ALTER TABLE "ci_container_usage" ADD CONSTRAINT "ci_container_usage_dispatch_run_id_fkey" FOREIGN KEY ("dispatch_run_id") REFERENCES "dispatch_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;
