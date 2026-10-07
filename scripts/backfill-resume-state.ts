/**
 * `pnpm db:backfill:resume-state` — recompute `WorkItem.resumeState` for every live
 * card through the shipped recompute (Story MOTIR-7701 · MOTIR-7707). The shape is
 * `pnpm db:backfill:fix-reason`'s, deliberately.
 *
 * WHY. A run that closed `gated` before the column existed has no next event coming,
 * so its cards would never reach the Workbench's To resume tab.
 *
 * IDEMPOTENT: a second run reports `changed: 0`. The dry run derives through the same
 * code without the lock or the write, so it predicts a real run exactly.
 *
 * Usage:
 *   pnpm db:backfill:resume-state --dry-run
 *   pnpm db:backfill:resume-state
 *   pnpm db:backfill:resume-state --workspace=<id>
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
import './_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads
import { db } from '@/lib/db';
import { workItemResumeStateBackfillService } from '@/lib/services/workItemResumeStateBackfillService';

const TAG = '[backfill-resume-state]';

function parseArgs(argv: string[]): { dryRun: boolean; workspaceId: string | undefined } {
  let dryRun = false;
  let workspaceId: string | undefined;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--workspace=')) workspaceId = arg.slice('--workspace='.length);
    else throw new Error(`${TAG} unknown argument: ${arg}`);
  }
  return { dryRun, workspaceId };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await workItemResumeStateBackfillService.backfillResumeState({
    dryRun: args.dryRun,
    ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
  });
  for (const change of report.changed) {
    console.log(
      `${TAG} ${args.dryRun ? 'would set' : 'set'} ${change.identifier}: ` +
        `${change.from ?? 'none'} → ${change.to ?? 'none'}`,
    );
  }
  for (const failure of report.failed) {
    console.error(`${TAG} FAILED ${failure.workItemId}: ${failure.error}`);
  }
  console.log(
    `${TAG} ${args.dryRun ? 'DRY RUN — ' : ''}scanned ${report.scanned}, ` +
      `changed ${report.changed.length}, unchanged ${report.unchanged}, ` +
      `failed ${report.failed.length}`,
  );
  if (report.failed.length > 0) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    console.error(`${TAG}`, err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
