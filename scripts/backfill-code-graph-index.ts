/**
 * `pnpm db:backfill:code-graph-index` — give a FIRST code graph to every
 * connected repo that never got one (MOTIR-1961).
 *
 * A repo connected BEFORE the initial-index feature shipped (MOTIR-1500) was
 * never "newly added" at any moment when the enqueue existed, and the old gate
 * skipped every already-persisted repo — so it had no trigger at all: not the
 * bind, not the webhook reconcile, not the push refresh. Its workspace is
 * silently code-blind, and nothing in the product says so. The gate itself is
 * fixed (it now asks "does this repo have a graph?", not "is this row new?"), so
 * a repo-selection change repairs a workspace from here on. This script is the
 * path for a workspace that will not see that event soon — the operator lever
 * that does not depend on the user touching GitHub's settings.
 *
 * It ENQUEUES; it does not index. Each repo gets one `system.code-graph-index`
 * job through the same chokepoint the webhook uses, so the fetch + the motir-ai
 * handoff run in the background job with the same payload, retries and ledger
 * rows as any other index. Watch the result in the job dashboard (the
 * `system.code-graph-index` runs) — a `succeeded` row carrying `output.repoRef`
 * is what "this repo is indexed" means, here and everywhere else.
 *
 * IDEMPOTENT + SAFE TO RE-RUN: it sweeps only repos with no succeeded index, so
 * a repo indexed since the last run drops out and a second consecutive run
 * enqueues nothing. Re-running while jobs are still in flight re-enqueues them
 * (the ledger cannot tie a `running` row to a repo) — harmless, since the job is
 * idempotent, but prefer the dry run to see where things stand.
 *
 * CROSS-TENANT BY DEFAULT: the defect is not one workspace's — every workspace
 * whose repos predate MOTIR-1500 has it. `--workspace=<id>` narrows the sweep to
 * one tenant.
 *
 * Usage:
 *   pnpm db:backfill:code-graph-index --dry-run              # rehearse: list, enqueue nothing
 *   pnpm db:backfill:code-graph-index                        # enqueue for every affected tenant
 *   pnpm db:backfill:code-graph-index --workspace=<id>       # scope to one workspace
 *
 * It runs against the LIVE tenant and needs the Inngest event key of the
 * environment whose app should run the jobs (`INNGEST_EVENT_KEY` — the same
 * variable the deployed app sends with). Do the dry run first.
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
import './_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads
import { db } from '@/lib/db';
import { codeGraphIndexService } from '@/lib/services/codeGraphIndexService';
import type { FirstIndexSweepReport } from '@/lib/services/codeGraphIndexService';

const TAG = '[backfill-code-graph-index]';

interface Args {
  dryRun: boolean;
  workspaceId: string | undefined;
}

function parseArgs(argv: string[]): Args {
  let dryRun = false;
  let workspaceId: string | undefined;

  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--workspace=')) workspaceId = arg.slice('--workspace='.length);
    else throw new Error(`${TAG} unknown argument: ${arg}`);
  }
  return { dryRun, workspaceId };
}

function printReport(report: FirstIndexSweepReport): void {
  console.log(
    `${TAG} scanned ${report.scanned} connected repo(s): ` +
      `${report.alreadyIndexed} already indexed, ${report.missing.length} with NO code graph.`,
  );
  for (const repo of report.missing) {
    console.log(
      `${TAG}   ${report.dryRun ? 'would enqueue' : 'enqueued'} ${repo.repoRef} ` +
        `(@${repo.defaultBranch}, workspace ${repo.workspaceId}, installation ${repo.installationId})`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.dryRun) console.log(`${TAG} DRY RUN — listing only, nothing will be enqueued.`);
  console.log(
    args.workspaceId
      ? `${TAG} scope: workspace ${args.workspaceId}.`
      : `${TAG} scope: every workspace with connected repos.`,
  );

  const report = await codeGraphIndexService.sweepReposMissingFirstIndex({
    ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
    dryRun: args.dryRun,
  });
  printReport(report);

  if (report.missing.length === 0) {
    console.log(`${TAG} done — every connected repo already has a code graph.`);
    return;
  }
  console.log(
    args.dryRun
      ? `${TAG} done — dry run, 0 jobs enqueued. Re-run without --dry-run to apply.`
      : `${TAG} done — ${report.enqueued} index job(s) enqueued. ` +
          `Watch the job dashboard for the 'system.code-graph-index' runs; each repo is ` +
          `indexed once its run reaches 'succeeded'.`,
  );
}

main()
  .catch((err) => {
    console.error(`${TAG} failed:`, err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
