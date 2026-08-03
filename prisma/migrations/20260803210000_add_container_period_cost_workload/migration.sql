-- THE INDEX FLEET'S COGS METER (Story MOTIR-1981 · MOTIR-1995) — the rollup
-- learns WHICH WORKLOAD it is summing.
--
-- `docs/decisions/code-graph-index-fleet.md` §2 puts code-graph index containers
-- in the SAME Fly org the CI runners bill, and Epic 9 adds hosted agents to it.
-- MOTIR-1924 anticipated that on the per-container row — `ci_container_usage.
-- workload` already ships, defaulted to `ci` — but NOT on the rollup, and the
-- rollup is where the question is actually asked: it exists so "what did this org
-- cost Motir this period?" is ONE indexed read, and with a single row per
-- (workspace, period) that read returns CI + index + agent added together. The
-- only route back to "what did INDEXING cost us?" would be the scan over
-- per-container rows the rollup exists to avoid — so the three workloads would
-- have been separable in principle and merged in practice.
--
-- Three rows instead of one makes each workload's line exactly as cheap as the
-- total, and keeps the CI margin readout honest: dividing an org's WHOLE fleet
-- cost by its metered CI minutes would fold index spend into a cost-per-CI-minute
-- figure, which is `ci-minutes-allowance.md` §Q.2's phantom-drift failure one
-- quantity over.
--
-- ⚠️ A NO-OP FOR EVERY EXISTING ROW. The column defaults to `ci`, which is what
-- every row MOTIR-1924's meter has written already is; the unique key gains a
-- column whose value is constant across the existing data, so no row can collide
-- and nothing needs backfilling.

-- AlterTable
ALTER TABLE "ci_container_period_cost" ADD COLUMN "workload" TEXT NOT NULL DEFAULT 'ci';

-- The upsert target becomes (workspace, period, workload). Dropped and recreated
-- rather than widened in place: Postgres has no ALTER on a unique index's column
-- list, and the two statements are safe in either order only inside one
-- transaction — which a Prisma migration file is.
-- DropIndex
DROP INDEX "ci_container_period_cost_workspace_id_period_start_key";

-- CreateIndex
CREATE UNIQUE INDEX "ci_container_period_cost_workspace_id_period_start_workload_key" ON "ci_container_period_cost"("workspace_id", "period_start", "workload");
